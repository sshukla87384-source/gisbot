import { loadConfig } from "@gis/config";
import { nextOrderNumber, prisma, type Currency } from "@gis/database";
import { NowPaymentsProvider, installProvider, type DirectCryptoPayment, type NowPaymentsCreds, type NormalizedPaymentEvent } from "@gis/payments";
import { CoreError, decryptSecret, encryptSecret, formatMinor, type CurrencyCode } from "@gis/shared";
import { enqueueAdminAlert, enqueueFulfillment, enqueueTelegramMessage } from "../queues.js";
import { getRedis } from "../redis.js";
import { toUsdtCharge, usdtToMinor } from "../fx.js";
import { adjustWallet } from "../wallet/wallet.service.js";
import { couponLines, priceCart } from "./assign.js";
import { recordCouponUseTx, releaseCouponForOrderTx, resolveCartCouponTx } from "./coupon.service.js";
import { applyWalletTx, cancelStalePendingTx } from "./manual-pay.service.js";
import { clearChatClutter, clearPaymentPrompts } from "./pay-prompt.service.js";
import { allocateTerminalPayment, checkTerminalPayment, terminalActiveChains, terminalChain, terminalHandles, terminalPaymentFor } from "../terminal/terminal.service.js";

/**
 * The crypto "terminal": a fresh deposit address for every payment.
 *
 * Customers pay USDT (or another coin) on the network of their choice. Each
 * order — and each wallet top-up — gets its OWN address from NOWPayments, so
 * two customers can never pay into the same wallet at the same time and no
 * amount needs a unique tail to be matched. NOWPayments watches the chain and
 * calls the IPN webhook; a 60 s poll (`pollCryptoPayments`) covers the cases
 * where the IPN cannot reach us (no PUBLIC_API_URL, a proxy hiccup).
 *
 * Why a processor and not our own addresses: a unique address per payment
 * means a private key per address on this server, native gas on every one of
 * them to sweep the USDT out, and a chain watcher per network. That is a
 * custody business, not a shop feature. NOWPayments does it for ~0.5 %.
 */

export interface CryptoNetwork {
  /** NOWPayments pay-currency code. */
  code: string;
  /** Button label. */
  label: string;
  asset: string;
  chain: string;
  emoji: string;
  /** Stablecoin — the amount the customer sends equals the USD price. */
  stable: boolean;
  /** Chain needs a memo / destination tag as well as an address. */
  memo?: boolean;
}

export const CRYPTO_NETWORKS: readonly CryptoNetwork[] = [
  // Catalogue order is picker order: the networks customers use most first.
  { code: "usdtbsc", label: "USDT · BEP20 (BSC)", asset: "USDT", chain: "BNB Smart Chain (BEP20)", emoji: "🟡", stable: true },
  { code: "usdttrc20", label: "USDT · TRC20 (Tron)", asset: "USDT", chain: "Tron (TRC20)", emoji: "🔴", stable: true },
  { code: "usdtsol", label: "USDT · Solana", asset: "USDT", chain: "Solana", emoji: "🟣", stable: true },
  { code: "ltc", label: "Litecoin (LTC)", asset: "LTC", chain: "Litecoin", emoji: "⚪", stable: false },
  { code: "usdtton", label: "USDT · TON", asset: "USDT", chain: "TON", emoji: "💎", stable: true, memo: true },
  { code: "usdterc20", label: "USDT · ERC20 (Ethereum)", asset: "USDT", chain: "Ethereum (ERC20)", emoji: "🔷", stable: true },
  { code: "usdtmatic", label: "USDT · Polygon", asset: "USDT", chain: "Polygon", emoji: "🟪", stable: true },
  { code: "usdtarb", label: "USDT · Arbitrum", asset: "USDT", chain: "Arbitrum One", emoji: "🔵", stable: true },
  { code: "usdcsol", label: "USDC · Solana", asset: "USDC", chain: "Solana", emoji: "🟣", stable: true },
  { code: "usdcbsc", label: "USDC · BEP20 (BSC)", asset: "USDC", chain: "BNB Smart Chain (BEP20)", emoji: "🟡", stable: true },
  { code: "usdcmatic", label: "USDC · Polygon", asset: "USDC", chain: "Polygon", emoji: "🟪", stable: true },
  { code: "usdc", label: "USDC · ERC20 (Ethereum)", asset: "USDC", chain: "Ethereum (ERC20)", emoji: "🔷", stable: true },
  { code: "btc", label: "Bitcoin (BTC)", asset: "BTC", chain: "Bitcoin", emoji: "🟠", stable: false },
  { code: "eth", label: "Ethereum (ETH)", asset: "ETH", chain: "Ethereum", emoji: "🔷", stable: false },
  { code: "bnbbsc", label: "BNB (BSC)", asset: "BNB", chain: "BNB Smart Chain", emoji: "🟡", stable: false },
  { code: "sol", label: "Solana (SOL)", asset: "SOL", chain: "Solana", emoji: "🟣", stable: false },
  { code: "trx", label: "TRON (TRX)", asset: "TRX", chain: "Tron", emoji: "🔴", stable: false },
  { code: "ton", label: "Toncoin (TON)", asset: "TON", chain: "TON", emoji: "💎", stable: false, memo: true },
  { code: "doge", label: "Dogecoin (DOGE)", asset: "DOGE", chain: "Dogecoin", emoji: "🐕", stable: false },
  { code: "xrp", label: "XRP", asset: "XRP", chain: "XRP Ledger", emoji: "⚫", stable: false, memo: true },
];

export const DEFAULT_CRYPTO_NETWORKS = ["usdtbsc", "usdttrc20", "usdtsol", "ltc", "usdtton"];

export function cryptoNetwork(code: string): CryptoNetwork | null {
  const c = code.toLowerCase();
  return CRYPTO_NETWORKS.find((n) => n.code === c) ?? null;
}

/** Orders stay payable this long; on-chain confirmations can take a while. */
export const CRYPTO_SESSION_MIN = 45;
const TOPUP_SESSION_MIN = 120;
const CREDS_KEY = "nowpayments.api";
const NETWORKS_KEY = "crypto.networks";
const TOPUP_PREFIX = "topup:";
const CARD_TTL = 48 * 3600;

// ── Credentials & provider ───────────────────────────────────────────────────

/** NOWPayments keys — admin-set (encrypted in DB) preferred, else .env. */
export async function getNowPaymentsCreds(): Promise<NowPaymentsCreds | null> {
  const cfg = loadConfig();
  try {
    const row = await prisma.setting.findUnique({ where: { key: CREDS_KEY } });
    const v = row?.value as { keyEnc?: string; ipnEnc?: string } | null | undefined;
    if (v?.keyEnc && v?.ipnEnc) {
      return { apiKey: decryptSecret(v.keyEnc, cfg.ENCRYPTION_MASTER_KEY), ipnSecret: decryptSecret(v.ipnEnc, cfg.ENCRYPTION_MASTER_KEY) };
    }
  } catch { /* fall back to env */ }
  if (cfg.NOWPAYMENTS_API_KEY && cfg.NOWPAYMENTS_IPN_SECRET) return { apiKey: cfg.NOWPAYMENTS_API_KEY, ipnSecret: cfg.NOWPAYMENTS_IPN_SECRET };
  return null;
}

export async function setNowPaymentsCreds(apiKey: string, ipnSecret: string): Promise<void> {
  const cfg = loadConfig();
  const value = { keyEnc: encryptSecret(apiKey.trim(), cfg.ENCRYPTION_MASTER_KEY), ipnEnc: encryptSecret(ipnSecret.trim(), cfg.ENCRYPTION_MASTER_KEY) };
  await prisma.setting.upsert({ where: { key: CREDS_KEY }, create: { key: CREDS_KEY, value }, update: { value } });
  await ensureCryptoProvider(true);
}

export async function clearNowPaymentsCreds(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: CREDS_KEY } });
  await ensureCryptoProvider(true);
}

let provider: NowPaymentsProvider | null = null;
let providerKey = "";
let providerCheckedAt = 0;

/**
 * Build the NOWPayments provider from whatever credentials are current and
 * register it with the payments registry, so the webhook server verifies IPNs
 * with the same secret the admin typed into the bot. Re-checked once a minute
 * — the bot and the worker are separate processes and only share the DB.
 */
export async function ensureCryptoProvider(force = false): Promise<NowPaymentsProvider | null> {
  const now = Date.now();
  if (!force && now - providerCheckedAt < 60_000) return provider;
  providerCheckedAt = now;
  const creds = await getNowPaymentsCreds();
  const key = creds ? `${creds.apiKey}:${creds.ipnSecret}` : "";
  if (key === providerKey && (provider || !creds)) return provider;
  providerKey = key;
  provider = creds ? new NowPaymentsProvider(creds) : null;
  installProvider("nowpayments", provider);
  return provider;
}

async function requireProvider(): Promise<NowPaymentsProvider> {
  const p = await ensureCryptoProvider();
  if (!p) throw new CoreError("VALIDATION_FAILED", "Crypto payments are not set up yet");
  return p;
}

// ── Networks ─────────────────────────────────────────────────────────────────

export async function getEnabledCryptoNetworks(): Promise<string[]> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: NETWORKS_KEY } });
    const v = row?.value;
    if (Array.isArray(v)) return v.map(String).filter((c) => cryptoNetwork(c));
  } catch { /* default below */ }
  return [...DEFAULT_CRYPTO_NETWORKS];
}

export async function setEnabledCryptoNetworks(codes: string[]): Promise<void> {
  const value = CRYPTO_NETWORKS.map((n) => n.code).filter((c) => codes.includes(c));
  await prisma.setting.upsert({ where: { key: NETWORKS_KEY }, create: { key: NETWORKS_KEY, value }, update: { value } });
}

export async function toggleCryptoNetwork(code: string): Promise<string[]> {
  const cur = await getEnabledCryptoNetworks();
  const next = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
  await setEnabledCryptoNetworks(next);
  return getEnabledCryptoNetworks();
}

/**
 * Shows the crypto button at checkout: the self-hosted terminal has at least
 * one network live, or NOWPayments keys are present with a network on.
 */
export async function cryptoTerminalReady(): Promise<boolean> {
  if ((await terminalActiveChains().catch(() => [])).length > 0) return true;
  const p = await ensureCryptoProvider();
  if (!p) return false;
  return (await getEnabledCryptoNetworks()).length > 0;
}

const MERCHANT_COINS_KEY = "nowpayments:coins";

/** Codes the merchant account can actually take, cached 10 min; null = unknown. */
async function merchantCoins(p: NowPaymentsProvider): Promise<Set<string> | null> {
  const redis = getRedis();
  try {
    const raw = await redis.get(MERCHANT_COINS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* fetch below */ }
  try {
    const list = await p.listPayCurrencies();
    if (list.length === 0) return null;
    await redis.set(MERCHANT_COINS_KEY, JSON.stringify(list), "EX", 600).catch(() => undefined);
    return new Set(list);
  } catch {
    return null;
  }
}

/**
 * Networks to offer, in catalogue order: every chain the self-hosted terminal
 * has live, plus — when NOWPayments is configured — the networks enabled there
 * and accepted by the merchant account. The terminal wins for a network both
 * can take.
 */
export async function availableCryptoNetworks(): Promise<CryptoNetwork[]> {
  const own = new Set((await terminalActiveChains().catch(() => [])).map((c) => c.code));
  const p = await ensureCryptoProvider();
  let viaProcessor = new Set<string>();
  if (p) {
    const enabled = await getEnabledCryptoNetworks();
    const coins = await merchantCoins(p);
    viaProcessor = new Set(enabled.filter((c) => coins === null || coins.has(c)));
  }
  return CRYPTO_NETWORKS.filter((n) => own.has(n.code) || viaProcessor.has(n.code));
}

/** Admin diagnostic: reach the API and report which enabled networks it will take. */
export async function testNowPayments(): Promise<{ ok: boolean; detail: string }> {
  const p = await ensureCryptoProvider(true);
  if (!p) return { ok: false, detail: "No NOWPayments API key saved yet." };
  try {
    const status = await p.ping();
    await getRedis().del(MERCHANT_COINS_KEY).catch(() => undefined);
    const coins = await merchantCoins(p);
    const enabled = await getEnabledCryptoNetworks();
    const lines = [`API: ${status}`];
    if (coins === null) lines.push("Could not read the coin list — networks are offered as enabled.");
    else {
      const ok = enabled.filter((c) => coins.has(c));
      const missing = enabled.filter((c) => !coins.has(c));
      lines.push(`Accepted: ${ok.length ? ok.map((c) => cryptoNetwork(c)?.label ?? c).join(", ") : "none"}`);
      if (missing.length) lines.push(`Not enabled on your NOWPayments account (turn them on at account.nowpayments.io → Store settings → Coins): ${missing.map((c) => cryptoNetwork(c)?.label ?? c).join(", ")}`);
    }
    const cfg = loadConfig();
    lines.push(cfg.PUBLIC_API_URL
      ? `IPN: ${cfg.PUBLIC_API_URL}/webhooks/payments/nowpayments (plus a 60 s poll as backup)`
      : "IPN: PUBLIC_API_URL is not set — payments are confirmed by the 60 s poll only.");
    return { ok: true, detail: lines.join("\n") };
  } catch (e) {
    return { ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 300) };
  }
}

// ── Checkout ─────────────────────────────────────────────────────────────────

/** What the payment card shows; kept in Redis so "show again" and polling can rebuild it. */
export interface CryptoCard {
  kind: "order" | "topup";
  /** Order id or WalletTopup id. */
  refId: string;
  orderNumber: string;
  userId: string;
  network: string;
  paymentId: string;
  payAddress: string;
  payAmount: string;
  payCurrency: string;
  payinExtraId: string | null;
  usdAmount: string;
  /** Owed in the user's currency (minor units) and that currency. */
  owedMinor: number;
  currency: Currency;
  expiresAt: string;
  /** Who watches the address: our own terminal or the processor. */
  provider: "terminal" | "nowpayments";
  /** Confirmations the customer is told to expect (terminal only). */
  confirmations?: number;
}

const cardKey = (kind: "order" | "topup", refId: string): string => `cryptocard:${kind}:${refId}`;

async function saveCard(card: CryptoCard): Promise<void> {
  try { await getRedis().set(cardKey(card.kind, card.refId), JSON.stringify(card), "EX", CARD_TTL); } catch { /* best effort */ }
}

export async function getCryptoCard(kind: "order" | "topup", refId: string): Promise<CryptoCard | null> {
  try {
    const raw = await getRedis().get(cardKey(kind, refId));
    return raw ? (JSON.parse(raw) as CryptoCard) : null;
  } catch {
    return null;
  }
}

export interface CryptoCheckoutResult extends CryptoCard {
  network: string;
  networkInfo: CryptoNetwork;
  walletUsedMinor: number;
  orderTotalMinor: number;
}

function ipnUrl(): string | undefined {
  const base = loadConfig().PUBLIC_API_URL;
  return base ? `${base.replace(/\/+$/, "")}/webhooks/payments/nowpayments` : undefined;
}

/**
 * Create a PENDING_PAYMENT order and a unique deposit address for it. Same
 * shape as the Binance manual checkout (cart → order → wallet first), plus a
 * soft stock reservation like the hosted-gateway path, because the customer
 * will take several minutes to pay and the keys must still be there.
 */
export async function createCryptoCheckout(userId: string, opts: { network: string; useWallet?: boolean }): Promise<CryptoCheckoutResult> {
  const net = cryptoNetwork(opts.network);
  if (!net) throw new CoreError("VALIDATION_FAILED", "Unknown network");
  // Our own terminal first; the processor only for networks it does not cover.
  const ownTerminal = await terminalHandles(net.code);
  if (!ownTerminal && !(await getEnabledCryptoNetworks()).includes(net.code)) throw new CoreError("VALIDATION_FAILED", "That network is not enabled");
  const p = ownTerminal ? null : await requireProvider();
  const providerEnum = ownTerminal ? "TERMINAL" as const : "NOWPAYMENTS" as const;

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const currency = user.currency as Currency;
  const expiresAt = new Date(Date.now() + CRYPTO_SESSION_MIN * 60_000);

  const created = await prisma.$transaction(async (tx) => {
    await cancelStalePendingTx(tx, userId);
    const lines = await priceCart(tx, userId, currency);
    const subtotalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
    const coupon = await resolveCartCouponTx(tx, userId, currency, subtotalMinor, couponLines(lines));
    const discountMinor = coupon?.discountMinor ?? 0;
    const totalMinor = Math.max(0, subtotalMinor - discountMinor);
    const orderNumber = await nextOrderNumber(tx);
    const order = await tx.order.create({
      data: {
        orderNumber, userId, status: "PENDING_PAYMENT", currency,
        subtotalMinor, discountMinor, couponId: coupon?.couponId ?? null, totalMinor, expiresAt,
        binanceAsset: net.code.toUpperCase(),
      },
    });
    if (coupon) await recordCouponUseTx(tx, coupon.couponId, userId, order.id, discountMinor);
    for (const line of lines) {
      const isUnitStocked = line.productType === "LICENSE_KEY" || line.productType === "DIGITAL_ACCOUNT";
      const unitCount = isUnitStocked ? line.quantity : 1;
      for (let i = 0; i < unitCount; i++) {
        await tx.orderItem.create({
          data: {
            orderId: order.id, variantId: line.variantId,
            productNameSnap: line.productName, variantNameSnap: line.variantName, resellerIdSnap: line.resellerId,
            quantity: isUnitStocked ? 1 : line.quantity, unitPriceMinor: line.unitPriceMinor,
            totalMinor: isUnitStocked ? line.unitPriceMinor : line.unitPriceMinor * line.quantity,
            fulfillmentMode: line.fulfillmentMode,
          },
        });
        if (isUnitStocked && line.fulfillmentMode === "AUTOMATIC") {
          const table = line.productType === "LICENSE_KEY" ? "LicenseKey" : "DigitalAccount";
          const reserved = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT "id" FROM "${table}"
             WHERE "variantId" = $1 AND "status" = 'AVAILABLE' AND "deletedAt" IS NULL
             ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
            line.variantId,
          );
          const row = reserved[0];
          if (!row) throw new CoreError("OUT_OF_STOCK");
          await tx.$executeRawUnsafe(`UPDATE "${table}" SET "status" = 'RESERVED', "reservedUntil" = $1 WHERE "id" = $2`, expiresAt, row.id);
        }
      }
    }
    const applied = opts.useWallet
      ? await applyWalletTx(tx, userId, order.id, orderNumber, totalMinor, { alignToUsdtCent: currency, orderCurrency: currency })
      : { walletUsed: 0, owed: totalMinor };
    // Priced in USD at the store's own rate — the same number a Binance customer
    // sees — so INR and USDT customers are charged consistently.
    const usd = toUsdtCharge(applied.owed, currency);
    const owedRecorded = usdToMinorSafe(usd, currency, applied.owed);
    if (owedRecorded !== applied.owed) await tx.order.update({ where: { id: order.id }, data: { totalMinor: owedRecorded } });
    await tx.order.update({ where: { id: order.id }, data: { binanceAmount: usd } });
    await tx.payment.create({
      data: {
        orderId: order.id, provider: providerEnum, status: "CREATED",
        currency: "USD", amountMinor: Math.round(Number.parseFloat(usd) * 100),
        idempotencyKey: `crypto:${order.id}`,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: userId, actorType: "USER", action: "order.checkout.crypto", entityType: "Order", entityId: order.id,
        after: { orderNumber, totalMinor: owedRecorded, currency, network: net.code, usd },
      },
    });
    return { orderId: order.id, orderNumber, totalMinor: owedRecorded, orderTotalMinor: totalMinor, walletUsedMinor: applied.walletUsed, usd };
  }, { timeout: 15_000 });

  // A unique address for this order — from our own seed, or from the processor.
  let pay: { paymentId: string; payAddress: string; payAmount: string; payCurrency: string; payinExtraId: string | null; confirmations?: number };
  try {
    if (ownTerminal || !p) {
      const a = await allocateTerminalPayment({ kind: "ORDER", refId: created.orderId, userId, chain: net.code, usd: Number.parseFloat(created.usd), expiresAt });
      pay = { paymentId: a.id, payAddress: a.address, payAmount: a.amount, payCurrency: net.code, payinExtraId: null, confirmations: a.confirmations };
    } else {
      const d: DirectCryptoPayment = await p.createPayment({
        orderId: created.orderId,
        priceAmount: Number.parseFloat(created.usd),
        priceCurrency: "USD",
        payCurrency: net.code,
        description: `${loadConfig().STORE_NAME} order ${created.orderNumber}`,
        ipnCallbackUrl: ipnUrl(),
      });
      pay = { paymentId: d.paymentId, payAddress: d.payAddress, payAmount: d.payAmount, payCurrency: d.payCurrency, payinExtraId: d.payinExtraId };
    }
  } catch (e) {
    // No address could be issued (coin off, amount under the network minimum,
    // price feed / RPC outage). Cancel the order, give back wallet money and
    // the coupon.
    await prisma.$transaction(async (tx) => {
      await cancelStalePendingTx(tx, userId);
      await releaseCouponForOrderTx(tx, created.orderId);
    }).catch(() => undefined);
    const msg = String(e instanceof Error ? e.message : e);
    throw new CoreError("VALIDATION_FAILED", friendlyProcessorError(msg, net), { cause: msg });
  }

  await prisma.payment.update({
    where: { idempotencyKey: `crypto:${created.orderId}` },
    data: { status: "PENDING", providerRef: pay.paymentId },
  });
  await prisma.auditLog.create({
    data: {
      actorType: "SYSTEM", action: "order.crypto.address", entityType: "Order", entityId: created.orderId,
      after: { provider: ownTerminal ? "terminal" : "nowpayments", paymentId: pay.paymentId, payAddress: pay.payAddress, payAmount: pay.payAmount, payCurrency: pay.payCurrency, memo: pay.payinExtraId },
    },
  }).catch(() => undefined);

  const card: CryptoCard = {
    kind: "order", refId: created.orderId, orderNumber: created.orderNumber, userId,
    network: net.code, paymentId: pay.paymentId, payAddress: pay.payAddress, payAmount: pay.payAmount,
    payCurrency: pay.payCurrency, payinExtraId: pay.payinExtraId, usdAmount: created.usd,
    owedMinor: created.totalMinor, currency, expiresAt: expiresAt.toISOString(),
    provider: ownTerminal ? "terminal" : "nowpayments",
    ...(pay.confirmations !== undefined ? { confirmations: pay.confirmations } : {}),
  };
  await saveCard(card);
  await enqueueAdminAlert(
    `🌐 New crypto order ${created.orderNumber} — ${formatMinor(created.totalMinor, currency as CurrencyCode)} = ${pay.payAmount} ${net.asset} on ${net.chain}. Confirms automatically when it lands.`,
  ).catch(() => undefined);
  return { ...card, networkInfo: net, walletUsedMinor: created.walletUsedMinor, orderTotalMinor: created.orderTotalMinor };
}

function usdToMinorSafe(usd: string, currency: Currency, fallback: number): number {
  const m = usdtToMinor(usd, currency);
  return Number.isFinite(m) && m > 0 ? m : fallback;
}

function friendlyProcessorError(msg: string, net: CryptoNetwork): string {
  const m = msg.toLowerCase();
  if (m.includes("min") && (m.includes("amount") || m.includes("minimal"))) {
    return `This order is below the minimum ${net.asset} payment on ${net.chain}. Try another network, or add more to your cart.`;
  }
  if (m.includes("currency") && (m.includes("not") || m.includes("unavailable") || m.includes("disabled"))) {
    return `${net.label} is not available right now — please choose another network.`;
  }
  if (m.includes("401") || m.includes("403") || m.includes("api key")) return "Crypto payments are temporarily unavailable. Please try Binance or UPI.";
  return "Could not create the crypto payment — please try again or pick another network.";
}

// ── Wallet top-ups ───────────────────────────────────────────────────────────

export interface CryptoTopupResult extends CryptoCard {
  networkInfo: CryptoNetwork;
  topupId: string;
}

/** Deposit into the wallet: `amountMinor` in the user's currency, paid in crypto. */
export async function createCryptoTopup(userId: string, amountMinor: number, network: string): Promise<CryptoTopupResult> {
  const net = cryptoNetwork(network);
  if (!net) throw new CoreError("VALIDATION_FAILED", "Unknown network");
  const ownTerminal = await terminalHandles(net.code);
  if (!ownTerminal && !(await getEnabledCryptoNetworks()).includes(net.code)) throw new CoreError("VALIDATION_FAILED", "That network is not enabled");
  if (!Number.isFinite(amountMinor) || amountMinor < 100) throw new CoreError("VALIDATION_FAILED", "Minimum top-up is 1.");
  amountMinor = Math.round(amountMinor);
  if (amountMinor > 100_000_00) throw new CoreError("VALIDATION_FAILED", "That top-up is too large — please contact support.");
  const p = ownTerminal ? null : await requireProvider();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const currency = user.currency as Currency;
  const usd = toUsdtCharge(amountMinor, currency);
  const expiresAt = new Date(Date.now() + TOPUP_SESSION_MIN * 60_000);

  // binanceAsset tags who watches it: "tm:" our terminal, "np:" the processor.
  const topup = await prisma.walletTopup.create({
    data: { userId, amountMinor, currency, binanceAsset: `${ownTerminal ? "tm" : "np"}:${net.code}`, binanceAmount: usd, expiresAt },
  });
  let pay: { paymentId: string; payAddress: string; payAmount: string; payCurrency: string; payinExtraId: string | null; confirmations?: number };
  try {
    if (ownTerminal || !p) {
      const a = await allocateTerminalPayment({ kind: "TOPUP", refId: topup.id, userId, chain: net.code, usd: Number.parseFloat(usd), expiresAt });
      pay = { paymentId: a.id, payAddress: a.address, payAmount: a.amount, payCurrency: net.code, payinExtraId: null, confirmations: a.confirmations };
    } else {
      const d: DirectCryptoPayment = await p.createPayment({
        orderId: `${TOPUP_PREFIX}${topup.id}`,
        priceAmount: Number.parseFloat(usd),
        priceCurrency: "USD",
        payCurrency: net.code,
        description: `${loadConfig().STORE_NAME} wallet top-up`,
        ipnCallbackUrl: ipnUrl(),
      });
      pay = { paymentId: d.paymentId, payAddress: d.payAddress, payAmount: d.payAmount, payCurrency: d.payCurrency, payinExtraId: d.payinExtraId };
    }
  } catch (e) {
    await prisma.walletTopup.update({ where: { id: topup.id }, data: { status: "CANCELLED" } }).catch(() => undefined);
    const msg = String(e instanceof Error ? e.message : e);
    throw new CoreError("VALIDATION_FAILED", friendlyProcessorError(msg, net), { cause: msg });
  }
  await prisma.walletTopup.update({
    where: { id: topup.id },
    data: { binanceTxnId: `${ownTerminal ? "tm" : "np"}:${pay.paymentId}`, binanceAmount: pay.payAmount },
  });
  const card: CryptoCard = {
    kind: "topup", refId: topup.id, orderNumber: `TOPUP-${topup.id.slice(-6).toUpperCase()}`, userId,
    network: net.code, paymentId: pay.paymentId, payAddress: pay.payAddress, payAmount: pay.payAmount,
    payCurrency: pay.payCurrency, payinExtraId: pay.payinExtraId, usdAmount: usd,
    owedMinor: amountMinor, currency, expiresAt: expiresAt.toISOString(),
    provider: ownTerminal ? "terminal" : "nowpayments",
    ...(pay.confirmations !== undefined ? { confirmations: pay.confirmations } : {}),
  };
  await saveCard(card);
  return { ...card, networkInfo: net, topupId: topup.id };
}

/**
 * Credit a crypto top-up exactly once. `creditMinor` overrides the amount for
 * a partial payment (what actually arrived, in the user's currency).
 */
export async function creditCryptoTopup(topupId: string, creditMinor?: number): Promise<{ credited: boolean; amountMinor: number; newBalanceMinor: bigint | null }> {
  const topup = await prisma.walletTopup.findUnique({ where: { id: topupId } });
  if (!topup) return { credited: false, amountMinor: 0, newBalanceMinor: null };
  const amount = Math.max(1, Math.round(creditMinor ?? topup.amountMinor));
  // The status flip is the lock: whichever of the IPN and the poll gets here
  // first credits, the other sees 0 rows and stops.
  const flipped = await prisma.walletTopup.updateMany({
    where: { id: topupId, status: "PENDING" },
    data: { status: "CREDITED", creditedAt: new Date(), amountMinor: amount },
  });
  if (flipped.count === 0) return { credited: false, amountMinor: 0, newBalanceMinor: null };
  const user = await prisma.user.findUnique({ where: { id: topup.userId }, select: { telegramId: true, currency: true } });
  const wallet = await prisma.wallet.findUnique({ where: { userId: topup.userId }, select: { currency: true } });
  // The top-up was quoted in the USER's currency; the wallet may hold another.
  const walletCur = (wallet?.currency ?? topup.currency) as Currency;
  const credit = walletCur === topup.currency ? amount : usdtToMinor(toUsdtCharge(amount, topup.currency as Currency), walletCur);
  const net = cryptoNetwork(topup.binanceAsset.replace(/^np:/, ""));
  const newBalance = await adjustWallet({
    userId: topup.userId, amountMinor: BigInt(credit), type: "DEPOSIT",
    note: `Crypto deposit (${net?.label ?? topup.binanceAsset})`, idempotencyKey: `cryptotopup:${topupId}`,
  });
  if (user?.telegramId != null) {
    await enqueueTelegramMessage(
      user.telegramId,
      `✅ <b>Wallet topped up!</b>\n\n💰 ${formatMinor(credit, walletCur as CurrencyCode)} added via ${net?.label ?? "crypto"}.\nNew balance: <b>${formatMinor(Number(newBalance), walletCur as CurrencyCode)}</b>. You can pay for any order instantly now. 🚀`,
    ).catch(() => undefined);
    await clearChatClutter(user.telegramId).catch(() => undefined);
  }
  await enqueueAdminAlert(`💰 Crypto top-up credited: ${formatMinor(credit, walletCur as CurrencyCode)} to user ${topup.userId} (${net?.label ?? topup.binanceAsset}).`).catch(() => undefined);
  return { credited: true, amountMinor: credit, newBalanceMinor: newBalance };
}

/** `order_id` of a top-up payment → the WalletTopup id, else null. */
export function topupIdFromOrderRef(orderRef: string | null | undefined): string | null {
  return orderRef && orderRef.startsWith(TOPUP_PREFIX) ? orderRef.slice(TOPUP_PREFIX.length) : null;
}

/** Fraction of the asked amount that arrived, clamped to [0, 1]; 1 when unknown. */
export function paidFraction(ev: NormalizedPaymentEvent): number {
  const asked = Number(ev.crypto?.payAmount);
  const got = Number(ev.crypto?.actuallyPaid);
  if (!Number.isFinite(asked) || asked <= 0 || !Number.isFinite(got)) return 1;
  return Math.max(0, Math.min(1, got / asked));
}

// ── Polling (IPN backup) ─────────────────────────────────────────────────────

/**
 * Feed a polled status through the SAME pipeline as an IPN: a WebhookEvent row
 * (deduped on provider + eventId) and the fulfilment queue. Returns true when a
 * new event was queued.
 */
async function queueStatusEvents(p: NowPaymentsProvider, paymentId: string): Promise<{ status: string; queued: boolean }> {
  const st = await p.getPayment(paymentId);
  let queued = false;
  for (const ev of p.statusToEvents(st)) {
    try {
      const row = await prisma.webhookEvent.create({
        data: { provider: "NOWPAYMENTS", eventId: ev.eventId, eventType: ev.type, rawBody: { normalized: ev, polled: true } as never },
      });
      await enqueueFulfillment(row.id);
      queued = true;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && (e as { code?: string }).code === "P2002")) throw e;
      const existing = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: "NOWPAYMENTS", eventId: ev.eventId } },
        select: { id: true, processedAt: true },
      });
      if (existing && !existing.processedAt) await enqueueFulfillment(existing.id);
    }
  }
  return { status: st.status, queued };
}

/**
 * Cron: look at every open crypto payment (orders and top-ups) that is young
 * enough to still be paid and ask NOWPayments where it stands. Cheap — one GET
 * per open payment per minute — and it is what makes the terminal work even
 * when no IPN can reach the server.
 */
export async function pollCryptoPayments(): Promise<number> {
  const p = await ensureCryptoProvider();
  if (!p) return 0;
  // Keep watching for two hours past the order's own window: a transfer that
  // left the exchange late still lands, and it should still be delivered.
  const grace = new Date(Date.now() - 2 * 3600_000);
  let advanced = 0;
  const payments = await prisma.payment.findMany({
    where: {
      provider: "NOWPAYMENTS", status: "PENDING", idempotencyKey: { startsWith: "crypto:" }, providerRef: { not: null },
      order: { OR: [{ status: "PENDING_PAYMENT" }, { status: "EXPIRED", expiresAt: { gte: grace } }] },
    },
    select: { providerRef: true },
    take: 200,
  });
  for (const pay of payments) {
    if (!pay.providerRef) continue;
    try {
      const r = await queueStatusEvents(p, pay.providerRef);
      if (r.queued) advanced++;
    } catch { /* one bad poll must not stop the rest */ }
  }
  // Payments whose order is long gone stop being polled.
  await prisma.payment.updateMany({
    where: {
      provider: "NOWPAYMENTS", status: "PENDING", idempotencyKey: { startsWith: "crypto:" },
      order: { status: { notIn: ["PENDING_PAYMENT"] }, expiresAt: { lt: grace } },
    },
    data: { status: "FAILED", failureReason: "payment window closed" },
  }).catch(() => undefined);

  const topups = await prisma.walletTopup.findMany({
    where: { status: "PENDING", binanceAsset: { startsWith: "np:" }, binanceTxnId: { startsWith: "np:" }, expiresAt: { gte: grace } },
    select: { id: true, binanceTxnId: true },
    take: 200,
  });
  for (const t of topups) {
    const pid = t.binanceTxnId?.slice(3);
    if (!pid) continue;
    try {
      const r = await queueStatusEvents(p, pid);
      if (r.queued) advanced++;
    } catch { /* next */ }
  }
  await prisma.walletTopup.updateMany({
    where: { status: "PENDING", binanceAsset: { startsWith: "np:" }, expiresAt: { lt: grace } },
    data: { status: "EXPIRED" },
  }).catch(() => undefined);
  return advanced;
}

/**
 * "Check payment" button: poll this one payment right now and say where it is.
 * Delivery itself still happens through the fulfilment queue so the IPN and the
 * button can never deliver twice.
 */
export async function checkCryptoPayment(kind: "order" | "topup", refId: string, userId: string): Promise<{
  status: string; actuallyPaid: string; payAmount: string; payCurrency: string; settled: boolean; queued: boolean;
}> {
  const card = await getCryptoCard(kind, refId);
  if (card && card.userId !== userId) throw new CoreError("VALIDATION_FAILED", "Not your payment");

  // Our own terminal: look at the chain right now and settle if it is in.
  const own = card?.provider === "terminal" ? await prisma.terminalPayment.findUnique({ where: { id: card.paymentId } }) : await terminalPaymentFor(kind === "order" ? "ORDER" : "TOPUP", refId);
  if (own) {
    if (own.userId !== userId) throw new CoreError("VALIDATION_FAILED", "Not your payment");
    const chain = terminalChain(own.chain);
    const row = await checkTerminalPayment(own.id);
    const map: Record<string, string> = { WAITING: "waiting", CONFIRMING: "confirming", PARTIAL: "partially_paid", PAID: "finished", EXPIRED: "expired" };
    const settledOwn = kind === "order"
      ? Boolean(await prisma.order.findFirst({ where: { id: refId, status: { in: ["PAID", "COMPLETED", "PENDING_FULFILLMENT", "AWAITING_STOCK"] } }, select: { id: true } }))
      : Boolean(await prisma.walletTopup.findFirst({ where: { id: refId, status: "CREDITED" }, select: { id: true } }));
    return {
      status: map[row.status] ?? row.status.toLowerCase(),
      actuallyPaid: row.receivedAmount,
      payAmount: row.expectedAmount,
      payCurrency: chain?.asset ?? own.chain,
      settled: settledOwn || row.status === "PAID",
      queued: false,
    };
  }

  const p = await requireProvider();
  let paymentId = card?.paymentId ?? null;
  if (!paymentId) {
    if (kind === "order") {
      const pay = await prisma.payment.findUnique({ where: { idempotencyKey: `crypto:${refId}` }, select: { providerRef: true, order: { select: { userId: true } } } });
      if (!pay || pay.order.userId !== userId) throw new CoreError("ORDER_NOT_FOUND");
      paymentId = pay.providerRef;
    } else {
      const t = await prisma.walletTopup.findUnique({ where: { id: refId }, select: { userId: true, binanceTxnId: true } });
      if (!t || t.userId !== userId) throw new CoreError("VALIDATION_FAILED", "Top-up not found");
      paymentId = t.binanceTxnId?.replace(/^np:/, "") ?? null;
    }
  }
  if (!paymentId) throw new CoreError("VALIDATION_FAILED", "No payment on record");
  const st = await p.getPayment(paymentId);
  const { queued } = await queueStatusEvents(p, paymentId);
  const settled = kind === "order"
    ? Boolean(await prisma.order.findFirst({ where: { id: refId, status: { in: ["PAID", "COMPLETED", "PENDING_FULFILLMENT", "AWAITING_STOCK"] } }, select: { id: true } }))
    : Boolean(await prisma.walletTopup.findFirst({ where: { id: refId, status: "CREDITED" }, select: { id: true } }));
  return { status: st.status, actuallyPaid: st.actuallyPaid, payAmount: st.payAmount, payCurrency: st.payCurrency, settled, queued };
}

/** Customer cancels before paying: close the order, refund wallet money, drop the card. */
export async function cancelCryptoOrder(orderId: string, userId: string): Promise<boolean> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true, status: true } });
  if (!order || order.userId !== userId || order.status !== "PENDING_PAYMENT") return false;
  await prisma.$transaction(async (tx) => { await cancelStalePendingTx(tx, userId); });
  await prisma.payment.updateMany({ where: { orderId, status: { in: ["CREATED", "PENDING"] } }, data: { status: "FAILED", failureReason: "cancelled by customer" } });
  await clearPaymentPrompts(orderId).catch(() => undefined);
  try { await getRedis().del(cardKey("order", orderId)); } catch { /* fine */ }
  return true;
}
