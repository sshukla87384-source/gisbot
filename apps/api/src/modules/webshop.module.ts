import {
  availableCryptoNetworks,
  buildMiniAppCatalog,
  checkCryptoPayment,
  createCryptoTopup,
  getProductIdBySlug,
  getRedis,
  getShopWebsiteLink,
  getWebShopEnabled,
  makeWebSession,
  miniAppBuyWithWallet,
  miniAppOrder,
  miniAppOrders,
  miniAppProfileFull,
  miniAppReferral,
  miniAppSetCurrency,
  miniAppWallet,
  releaseMaturedReferralRewards,
  verifyTelegramLogin,
  webLoginUser,
  webSessionUser,
  webShopProduct,
  revokeWebSessions,
  type TelegramLogin,
} from "@gis/core";
import { loadConfig } from "@gis/config";
import { isCoreError } from "@gis/shared";
import { prisma, type Currency } from "@gis/database";
import { Body, Controller, Get, Header, Module, Param, Post, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ApiError } from "../common/errors.js";
import { Public, SkipEnvelope } from "../common/permissions.decorator.js";
import type { ApiRequest, ApiResponse } from "../common/types.js";
import { webShopPage, webShopClosedPage } from "./webshop.page.js";

/**
 * The shop as a website — same products, customers, wallet and orders as the
 * bot. Served at /api/v1/shop (nginx also maps https://<host>/shop to it).
 *
 *   GET  /shop                       the page (HTML, self-contained)
 *   GET  /shop/config                store name, bot, login widget, networks
 *   GET  /shop/catalog?currency      public catalogue (same as the Mini App)
 *   GET  /shop/product/:id?currency  one product card (description / how to use / terms / bulk)
 *   POST /shop/auth/telegram         Telegram Login Widget payload → session cookie
 *   POST /shop/auth/logout
 *   GET  /shop/me | orders | orders/:id | wallet | referral     signed-in reads
 *   POST /shop/buy {variantId, qty, quoteMinor, quoteCurrency}  wallet purchase
 *   POST /shop/topup/crypto {amount, network} · GET /shop/topup/:id
 *   POST /shop/currency · POST /shop/referral/claim
 *
 * Auth: an HMAC-signed, httpOnly, SameSite=Lax cookie. Every POST must carry
 * "X-Shop: 1" — a cross-site form cannot send a custom header, which closes
 * CSRF without a token dance.
 */
const COOKIE = "gis_shop";

const SHOP_CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; " +
  "script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; " +
  "frame-src https://oauth.telegram.org https://telegram.org";

const currencyQ = z.enum(["USD", "INR"]).catch("USD");
const loginBody = z.object({
  id: z.union([z.number(), z.string()]),
  first_name: z.string().max(128).optional(),
  last_name: z.string().max(128).optional(),
  username: z.string().max(64).optional(),
  photo_url: z.string().max(512).optional(),
  auth_date: z.union([z.number(), z.string()]),
  hash: z.string().length(64),
  ref: z.string().max(40).optional(),
});
// The quote is required: it is what the order limits and the price guard check.
const buyBody = z.object({
  variantId: z.string().min(1).max(64),
  qty: z.number().int().min(1).max(100_000),
  quoteMinor: z.number().int().min(1).max(10_000_000_000),
  quoteCurrency: z.enum(["USD", "INR"]),
  idem: z.string().min(8).max(64).regex(/^[A-Za-z0-9._-]+$/),
});
const topupBody = z.object({ amount: z.number().positive().max(100_000), network: z.string().min(2).max(32) });

async function botUsername(): Promise<string | null> {
  const cfg = loadConfig();
  if (cfg.BOT_USERNAME) return cfg.BOT_USERNAME.replace(/^@/, "");
  const row = await prisma.setting.findUnique({ where: { key: "bot.username" } }).catch(() => null);
  return (row?.value as { username?: string } | null)?.username ?? null;
}

/** N requests per window per key, in Redis. */
async function limit(key: string, max: number, windowSec: number): Promise<void> {
  const redis = getRedis();
  const n = await redis.incr(`shoprl:${key}`).catch(() => 0);
  if (n === 1) await redis.expire(`shoprl:${key}`, windowSec).catch(() => undefined);
  if (n > max) throw new ApiError(429, "RATE_LIMITED", "Too many requests — please wait a moment.");
}

@ApiTags("shop")
@Public()
@Controller("shop")
export class WebShopController {
  @Get()
  @SkipEnvelope()
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Content-Security-Policy", SHOP_CSP)
  @Header("Cache-Control", "no-store")
  // The Telegram login opens a popup that reports back to this page; helmet's
  // "same-origin" opener policy would cut that link.
  @Header("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
  async page(): Promise<string> {
    const store = loadConfig().STORE_NAME;
    if (!(await getWebShopEnabled())) return webShopClosedPage(store);
    return webShopPage(store);
  }

  @Get("config")
  async config() {
    const [bot, nets, site] = await Promise.all([botUsername(), availableCryptoNetworks().catch(() => []), getShopWebsiteLink().catch(() => null)]);
    return {
      store: loadConfig().STORE_NAME,
      bot,
      website: site,
      enabled: await getWebShopEnabled(),
      networks: nets.map((n) => ({ code: n.code, label: n.label, asset: n.asset, chain: n.chain, emoji: n.emoji })),
    };
  }

  @Get("catalog")
  @Header("Cache-Control", "public, max-age=30")
  async catalog(@Query("currency") currency?: string) {
    if (!(await getWebShopEnabled())) throw new ApiError(404, "DISABLED", "The web shop is closed.");
    return buildMiniAppCatalog(currencyQ.parse(currency));
  }

  @Get("product/:id")
  async product(@Param("id") idOrSlug: string, @Query("currency") currency: string | undefined, @Req() req: ApiRequest) {
    if (!(await getWebShopEnabled())) throw new ApiError(404, "DISABLED", "The web shop is closed.");
    const user = await webSessionUser(this.cookie(req));
    // A slug (from a shared link) or the product id (from the catalogue).
    const key = idOrSlug.slice(0, 120);
    const id = (await getProductIdBySlug(key).catch(() => null)) ?? key;
    try {
      return await webShopProduct(id, (user?.currency ?? currencyQ.parse(currency)) as Currency, user?.id);
    } catch (e) {
      if (isCoreError(e)) throw new ApiError(404, "NOT_FOUND", "Product not found.");
      throw e;
    }
  }

  // ── auth ──

  @Post("auth/telegram")
  async login(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    this.csrf(req);
    await limit(`login:${req.ip}`, 10, 60);
    // Unknown fields are kept: every field Telegram sends is part of its signature.
    const parsed = loginBody.passthrough().safeParse(body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION", "Bad login data.");
    const { ref, ...tg } = parsed.data;
    if (!verifyTelegramLogin(tg as unknown as TelegramLogin)) throw new ApiError(401, "BAD_LOGIN", "Telegram login could not be verified — please try again.");
    const u = await webLoginUser(tg as unknown as TelegramLogin, ref ?? null);
    if (u.status !== "ACTIVE") throw new ApiError(403, "BANNED", "This account is suspended.");
    const s = await makeWebSession(u.id);
    res.cookie(COOKIE, s.token, { httpOnly: true, secure: loadConfig().NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: s.maxAgeSec * 1000 });
    return { ok: true };
  }

  @Post("auth/logout")
  async logout(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    this.csrf(req);
    // Every session of this customer ends, not just this browser's cookie.
    const user = await webSessionUser(this.cookie(req)).catch(() => null);
    if (user) await revokeWebSessions(user.id).catch(() => undefined);
    res.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  }

  // ── signed in ──

  @Get("me")
  async me(@Req() req: ApiRequest) {
    const user = await this.who(req);
    const [profile, wallet] = await Promise.all([miniAppProfileFull(user.id, user.telegramId), miniAppWallet(user.id)]);
    return { ...profile, balanceMinor: wallet.balanceMinor, walletCurrency: wallet.currency };
  }

  @Get("orders")
  async orders(@Req() req: ApiRequest, @Query("page") page?: string) {
    const user = await this.who(req);
    return miniAppOrders(user.id, Math.max(1, Math.min(500, Number(page ?? 1) || 1)));
  }

  @Get("orders/:id")
  @Header("Cache-Control", "no-store")
  async order(@Req() req: ApiRequest, @Param("id") id: string) {
    const user = await this.who(req);
    const o = await miniAppOrder(user.id, id.slice(0, 64));
    if (!o) throw new ApiError(404, "NOT_FOUND", "Order not found.");
    return o;
  }

  @Get("wallet")
  async wallet(@Req() req: ApiRequest) {
    const user = await this.who(req);
    return miniAppWallet(user.id);
  }

  @Get("referral")
  async referral(@Req() req: ApiRequest) {
    const user = await this.who(req);
    return miniAppReferral(user.id, user.referralCode, await botUsername());
  }

  @Post("referral/claim")
  async claim(@Req() req: ApiRequest) {
    this.csrf(req);
    const user = await this.who(req);
    const r = await releaseMaturedReferralRewards({ referrerId: user.id, limit: 100 });
    return { credited: r.credited, creditedMinor: r.creditedMinor, currency: r.currency };
  }

  @Post("currency")
  async currency(@Req() req: ApiRequest, @Body() body: unknown) {
    this.csrf(req);
    const user = await this.who(req);
    const c = z.object({ currency: z.enum(["USD", "INR"]) }).safeParse(body);
    if (!c.success) throw new ApiError(400, "VALIDATION", "Pick USD or INR.");
    await miniAppSetCurrency(user.id, c.data.currency);
    return { ok: true, currency: c.data.currency };
  }

  @Post("buy")
  @Header("Cache-Control", "no-store")
  async buy(@Req() req: ApiRequest, @Body() body: unknown) {
    this.csrf(req);
    const user = await this.who(req);
    await limit(`buy:${user.id}`, 20, 60);
    const b = buyBody.safeParse(body);
    if (!b.success) throw new ApiError(400, "VALIDATION", "Bad request — please reload the page.");
    // Idempotent per click: a retried request gets the first result back (or
    // "still processing"), never a second order.
    const redis = getRedis();
    const idemKey = `shopbuy:${user.id}:${b.data.idem}`;
    const claimed = await redis.set(idemKey, "__pending__", "EX", 900, "NX").catch(() => "OK");
    if (claimed !== "OK") {
      const prev = await redis.get(idemKey).catch(() => null);
      if (prev && prev !== "__pending__") return JSON.parse(prev) as unknown;
      throw new ApiError(409, "IN_PROGRESS", "This purchase is still processing — check 📦 Orders in a moment.");
    }
    const quote = { totalMinor: b.data.quoteMinor, currency: b.data.quoteCurrency as Currency };
    try {
      const r = await miniAppBuyWithWallet({ id: user.id, telegramId: user.telegramId, currency: user.currency }, b.data.variantId, b.data.qty, quote);
      // A refusal (balance, stock, price change) frees the key so the same click can be retried.
      if (r.ok) await redis.set(idemKey, JSON.stringify(r), "EX", 900).catch(() => undefined);
      else await redis.del(idemKey).catch(() => undefined);
      return r;
    } catch (e) {
      // Unknown outcome: keep the key for its TTL so a blind retry cannot buy twice.
      throw e;
    }
  }

  @Post("topup/crypto")
  async topup(@Req() req: ApiRequest, @Body() body: unknown) {
    this.csrf(req);
    const user = await this.who(req);
    await limit(`topup:${user.id}`, 10, 300);
    const b = topupBody.safeParse(body);
    if (!b.success) throw new ApiError(400, "VALIDATION", "Enter an amount and pick a network.");
    try {
      const t = await createCryptoTopup(user.id, Math.round(b.data.amount * 100), b.data.network);
      return {
        id: t.topupId, address: t.payAddress, amount: t.payAmount, asset: t.networkInfo.asset, chain: t.networkInfo.chain,
        memo: t.payinExtraId, expiresAt: t.expiresAt, owedMinor: t.owedMinor, currency: t.currency, confirmations: t.confirmations ?? null,
      };
    } catch (e) {
      if (isCoreError(e)) throw new ApiError(400, e.code, e.message);
      throw e;
    }
  }

  @Get("topup/:id")
  async topupStatus(@Req() req: ApiRequest, @Param("id") id: string) {
    const user = await this.who(req);
    await limit(`topupchk:${user.id}`, 30, 60);
    try {
      const r = await checkCryptoPayment("topup", id.slice(0, 64), user.id);
      return { status: r.status, received: r.actuallyPaid, expected: r.payAmount, asset: r.payCurrency, credited: r.settled };
    } catch (e) {
      if (isCoreError(e)) throw new ApiError(400, e.code, e.message);
      throw e;
    }
  }

  // ── helpers ──

  private cookie(req: ApiRequest): string | undefined {
    return (req.cookies as Record<string, string> | undefined)?.[COOKIE];
  }

  private csrf(req: ApiRequest): void {
    if (req.headers["x-shop"] !== "1") throw new ApiError(403, "FORBIDDEN", "Missing shop header.");
  }

  private async who(req: ApiRequest) {
    if (!(await getWebShopEnabled())) throw new ApiError(404, "DISABLED", "The web shop is closed.");
    const user = await webSessionUser(this.cookie(req));
    if (!user) throw new ApiError(401, "LOGIN_REQUIRED", "Please log in with Telegram.");
    return user;
  }
}

@Module({ controllers: [WebShopController] })
export class WebShopModule {}
