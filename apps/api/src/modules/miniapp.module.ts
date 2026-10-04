import {
  buildMiniAppCatalog,
  getMiniAppConfig,
  miniAppBuyWithWallet,
  miniAppOrder,
  miniAppOrders,
  miniAppProfile,
  miniAppProfileFull,
  miniAppReferral,
  miniAppSetCurrency,
  miniAppWallet,
  releaseMaturedReferralRewards,
  resolveMiniAppUser,
  verifyInitData,
} from "@gis/core";
import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { Body, Controller, Get, Header, Module, Post, Query, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ApiError } from "../common/errors.js";
import { Public, SkipEnvelope } from "../common/permissions.decorator.js";
import type { ApiResponse } from "../common/types.js";
import { disabledPage, storefrontPage } from "./miniapp.page.js";

/**
 * Telegram Mini App — the whole bot menu as a web page.
 *
 *   GET  /miniapp                      the page (HTML, self-contained)
 *   GET  /miniapp/catalog?currency      public catalogue JSON (cached a minute in core)
 *   POST /miniapp/me                    {initData} → viewer header
 *   POST /miniapp/orders|order|wallet|referral|profile   signed-in reads
 *   POST /miniapp/buy                   {initData, variantId, qty} → wallet purchase (delivery also goes to the chat)
 *   POST /miniapp/referral/claim        move matured referral rewards to the wallet
 *   POST /miniapp/currency              {initData, currency}
 *
 * Every signed-in call re-verifies initData (HMAC over the bot token, ≤ 24 h
 * old); there is no session of its own. Other payment rails (UPI, Binance,
 * crypto) stay in the chat: the page deep-links to the bot for them. The CSP
 * is route-level because helmet's default forbids both the Telegram SDK and
 * the inline script, and `frame-ancestors` must admit web.telegram.org.
 */
const MINIAPP_CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'none'; " +
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://*.t.me; " +
  "script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'";

const currencyQ = z.enum(["USD", "INR"]).catch("USD");
const authed = z.object({ initData: z.string().min(1).max(8192) });
const ordersBody = authed.extend({ page: z.number().int().min(1).max(500).optional() });
const orderBody = authed.extend({ orderId: z.string().min(1).max(64) });
const buyBody = authed.extend({ variantId: z.string().min(1).max(64), qty: z.number().int().min(1).max(50).optional() });
const currencyBody = authed.extend({ currency: z.enum(["USD", "INR"]) });

async function botUsername(): Promise<string | null> {
  const cfg = loadConfig();
  if (cfg.BOT_USERNAME) return cfg.BOT_USERNAME;
  const row = await prisma.setting.findUnique({ where: { key: "bot.username" } }).catch(() => null);
  return (row?.value as { username?: string } | null)?.username ?? null;
}

@ApiTags("miniapp")
@Public()
@Controller("miniapp")
export class MiniAppController {
  @Get()
  @SkipEnvelope()
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Content-Security-Policy", MINIAPP_CSP)
  @Header("Cache-Control", "no-store")
  async page(@Res({ passthrough: true }) res: ApiResponse): Promise<string> {
    // helmet adds X-Frame-Options: SAMEORIGIN; CSP frame-ancestors is the
    // modern rule and must win, so the legacy header goes.
    res.removeHeader("X-Frame-Options");
    const cfg = await getMiniAppConfig();
    if (!cfg.enabled) return disabledPage(loadConfig().STORE_NAME);
    return storefrontPage(loadConfig().STORE_NAME);
  }

  @Get("catalog")
  @Header("Cache-Control", "public, max-age=30")
  async catalog(@Query("currency") currency?: string) {
    const cfg = await getMiniAppConfig();
    if (!cfg.enabled) throw new ApiError(404, "DISABLED", "Mini App is turned off.");
    return buildMiniAppCatalog(currencyQ.parse(currency));
  }

  @Post("me")
  async me(@Body() body: unknown) {
    const parsed = authed.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION", "initData required");
    const user = verifyInitData(parsed.data.initData);
    if (!user) throw new ApiError(401, "BAD_INITDATA", "Telegram signature check failed.");
    const profile = await miniAppProfile(user.telegramId);
    return { user, ...profile, bot: await botUsername() };
  }

  private async who(body: unknown, schema: z.ZodTypeAny = authed) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION", "Bad request");
    const data = parsed.data as z.infer<typeof authed> & Record<string, unknown>;
    const user = await resolveMiniAppUser(data.initData);
    if (!user) throw new ApiError(401, "NOT_A_CUSTOMER", "Open the bot and tap Start once, then come back.");
    return { user, data };
  }

  @Post("orders")
  async orders(@Body() body: unknown) {
    const { user, data } = await this.who(body, ordersBody);
    return miniAppOrders(user.id, Number(data.page ?? 1));
  }

  @Post("order")
  async order(@Body() body: unknown) {
    const { user, data } = await this.who(body, orderBody);
    const o = await miniAppOrder(user.id, String(data.orderId));
    if (!o) throw new ApiError(404, "NOT_FOUND", "Order not found.");
    return o;
  }

  @Post("wallet")
  async wallet(@Body() body: unknown) {
    const { user } = await this.who(body);
    return miniAppWallet(user.id);
  }

  @Post("referral")
  async referral(@Body() body: unknown) {
    const { user } = await this.who(body);
    return miniAppReferral(user.id, user.referralCode, await botUsername());
  }

  @Post("referral/claim")
  async claim(@Body() body: unknown) {
    const { user } = await this.who(body);
    const r = await releaseMaturedReferralRewards({ referrerId: user.id, limit: 100 });
    return { credited: r.credited, creditedMinor: r.creditedMinor, currency: r.currency };
  }

  @Post("profile")
  async profile(@Body() body: unknown) {
    const { user } = await this.who(body);
    return miniAppProfileFull(user.id, user.telegramId);
  }

  @Post("currency")
  async currency(@Body() body: unknown) {
    const { user, data } = await this.who(body, currencyBody);
    await miniAppSetCurrency(user.id, data.currency as "USD" | "INR");
    return { ok: true, currency: data.currency };
  }

  @Post("buy")
  async buy(@Body() body: unknown) {
    const { user, data } = await this.who(body, buyBody);
    return miniAppBuyWithWallet({ id: user.id, telegramId: user.telegramId, currency: user.currency }, String(data.variantId), Number(data.qty ?? 1));
  }
}

@Module({ controllers: [MiniAppController] })
export class MiniAppModule {}
