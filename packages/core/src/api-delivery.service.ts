import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { prisma } from "@gis/database";
import { getRedis } from "./redis.js";
import { enqueueTelegramMessage } from "./queues.js";
import { revealOrderDeliveries } from "./orders/order.service.js";

/**
 * Deliveries for orders a reseller placed through the developer API.
 *
 * An API order whose items are delivered LATER — by the admin entering a key,
 * by a supplier, or from a restock — used to reach the reseller only as a
 * Telegram message in their own chat with this bot. Their storefront (and so
 * their customer) never saw it: GET /orders/{n} returned no items at all and
 * nothing was pushed. Now the delivery is readable from GET /orders/{n} and,
 * when the reseller set a webhook, POSTed to it the moment it happens.
 */

// ───────────────────────── shared API shape ─────────────────────────

export interface ApiDeliveryItem {
  id?: string;
  product: string;
  variant?: string;
  kind: string;
  value: string;
  values: string[];
  expiresAt?: string;
  secret: unknown;
  activationGuide?: string;
  replaced?: boolean;
}

/**
 * One delivered unit as the API returns it. `value` is the key / link itself,
 * or `username|password[|2fa]` for an account — one line per unit — so a
 * storefront can show it as-is. The default variant ("Standard") is omitted.
 */
export function formatApiDeliveryItem(d: {
  productName: string;
  variantName: string;
  payload: { kind: string; key?: string; username?: string; password?: string; twofa?: string; expiresAt?: string };
  activationGuide?: string | null;
  orderItemId?: string;
  replaced?: boolean;
}): ApiDeliveryItem {
  const p = d.payload;
  const values: string[] = [];
  if (p.key) values.push(...p.key.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  if (p.username || p.password) values.push([p.username ?? "", p.password ?? "", p.twofa ?? ""].filter(Boolean).join("|"));
  const isDefaultVariant = d.variantName.trim().toLowerCase() === "standard";
  return {
    ...(d.orderItemId ? { id: d.orderItemId } : {}),
    product: d.productName,
    ...(isDefaultVariant ? {} : { variant: d.variantName }),
    kind: p.kind,
    value: values.join("\n"),
    values,
    ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
    secret: p as unknown,
    ...(d.activationGuide ? { activationGuide: d.activationGuide } : {}),
    ...(d.replaced ? { replaced: true } : {}),
  };
}

/** Plain, numbered text a storefront can show as-is: `1.` then the value, product name once. */
export function formatApiDeliveryText(items: ApiDeliveryItem[]): string {
  const out: string[] = [];
  let n = 0;
  let lastProduct = "";
  for (const it of items) {
    if (it.replaced) continue;
    const label = it.variant ? `${it.product} — ${it.variant}` : it.product;
    if (label !== lastProduct) { out.push(`${out.length ? "\n" : ""}${label}`); lastProduct = label; }
    for (const v of it.values) { n += 1; out.push(`${n}.`, v); }
  }
  return out.join("\n");
}

/** Everything an API client needs about one of its orders, deliveries included. */
export async function apiOrderDetail(userId: string, orderId: string): Promise<{
  items: ApiDeliveryItem[];
  deliveryText: string;
  pendingItems: number;
  refundedItems: number;
}> {
  const [delivered, pendingItems, refundedItems, guides] = await Promise.all([
    revealOrderDeliveries(userId, orderId),
    prisma.orderItem.count({ where: { orderId, fulfilledAt: null, refundedAt: null } }),
    prisma.orderItem.count({ where: { orderId, refundedAt: { not: null } } }),
    prisma.orderItem.findMany({ where: { orderId }, select: { id: true, variant: { select: { product: { select: { activationGuide: true } } } } } }),
  ]);
  const guideOf = new Map(guides.map((g) => [g.id, g.variant.product.activationGuide]));
  const items = delivered.map((d) => formatApiDeliveryItem({ ...d, activationGuide: d.orderItemId ? guideOf.get(d.orderItemId) ?? null : null }));
  return { items, deliveryText: formatApiDeliveryText(items), pendingItems, refundedItems };
}

/** Mark what was already handed back in an API response, so the webhook does not repeat it. */
export async function markApiDelivered(orderId: string): Promise<void> {
  await prisma.orderItem.updateMany({
    where: { orderId, fulfilledAt: { not: null }, apiNotifiedAt: null },
    data: { apiNotifiedAt: new Date() },
  });
}

// ───────────────────────── webhook settings ─────────────────────────

const WH_KEY = (userId: string) => `api.webhook.${userId}`;

export interface ApiWebhook { url: string; secret: string }

export async function getApiWebhook(userId: string): Promise<ApiWebhook | null> {
  const row = await prisma.setting.findUnique({ where: { key: WH_KEY(userId) } }).catch(() => null);
  const v = row?.value as { url?: unknown; secret?: unknown } | null | undefined;
  return v && typeof v.url === "string" && typeof v.secret === "string" && v.url ? { url: v.url, secret: v.secret } : null;
}

/**
 * Save the reseller's delivery webhook. Only public https endpoints: the
 * server POSTs to this URL, so an address inside our own network (localhost,
 * 10.x, the cloud metadata service…) must never be accepted.
 */
export async function setApiWebhook(userId: string, rawUrl: string): Promise<{ ok: true; hook: ApiWebhook } | { ok: false; reason: string }> {
  const check = await checkWebhookUrl(rawUrl.trim());
  if (!check.ok) return check;
  const prev = await getApiWebhook(userId);
  const hook = { url: check.url, secret: prev?.secret ?? `whsec_${randomBytes(24).toString("hex")}` };
  await prisma.setting.upsert({ where: { key: WH_KEY(userId) }, create: { key: WH_KEY(userId), value: hook as never }, update: { value: hook as never } });
  return { ok: true, hook };
}

export async function clearApiWebhook(userId: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: WH_KEY(userId) } });
}

/** A new signing secret (the old one stops verifying at once). */
export async function rotateApiWebhookSecret(userId: string): Promise<ApiWebhook | null> {
  const cur = await getApiWebhook(userId);
  if (!cur) return null;
  const hook = { url: cur.url, secret: `whsec_${randomBytes(24).toString("hex")}` };
  await prisma.setting.update({ where: { key: WH_KEY(userId) }, data: { value: hook as never } });
  return hook;
}

function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split(".").map((x) => Number.parseInt(x, 10));
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return privateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

async function checkWebhookUrl(raw: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: "That is not a valid URL." }; }
  if (u.protocol !== "https:") return { ok: false, reason: "The webhook must start with https://" };
  if (u.username || u.password) return { ok: false, reason: "Put no username/password in the URL." };
  if (raw.length > 500) return { ok: false, reason: "That URL is too long." };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$/i.test(host)) return { ok: false, reason: "The webhook must be a public internet address." };
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    return { ok: false, reason: "That domain does not resolve." };
  }
  if (addrs.length === 0 || addrs.some(privateAddress)) return { ok: false, reason: "The webhook must be a public internet address." };
  return { ok: true, url: u.toString() };
}

/** POST one signed event. True on a 2xx answer. */
async function postWebhook(hook: ApiWebhook, event: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status?: number; error?: string }> {
  // Re-checked on every send: the domain may have been re-pointed since it was saved.
  const check = await checkWebhookUrl(hook.url);
  if (!check.ok) return { ok: false, error: check.reason };
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), ...payload });
  const sig = createHmac("sha256", hook.secret).update(body).digest("hex");
  try {
    const res = await fetch(check.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", "user-agent": "store-webhook/1", "x-event": event, "x-signature": `sha256=${sig}` },
      body,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 120) };
  }
}

/** "🧪 Send test" from the bot. */
export async function sendTestApiWebhook(userId: string): Promise<{ ok: boolean; detail: string }> {
  const hook = await getApiWebhook(userId);
  if (!hook) return { ok: false, detail: "No webhook set." };
  const r = await postWebhook(hook, "ping", { message: "Webhook test — deliveries for your API orders will arrive here." });
  return r.ok ? { ok: true, detail: `Your server answered ${r.status}.` } : { ok: false, detail: r.status ? `Your server answered ${r.status} (needs 2xx).` : (r.error ?? "No answer.") };
}

// ───────────────────────── the sweep ─────────────────────────

const MAX_TRIES = 12;

/**
 * Push every API-order delivery that has not reached the reseller's API yet.
 * Runs from the worker every 20 s. Items delivered inside the purchase response
 * are already marked; this covers everything delivered afterwards. Orders whose
 * owner has no webhook are marked too — GET /orders/{n} still returns them.
 */
export async function dispatchApiDeliveryWebhooks(limit = 200): Promise<{ sent: number; failed: number }> {
  const now = Date.now();
  const rows = await prisma.orderItem.findMany({
    where: {
      apiNotifiedAt: null,
      // 10 s grace: a purchase response marks its own instant deliveries.
      fulfilledAt: { gte: new Date(now - 48 * 3600_000), lte: new Date(now - 10_000) },
      deliveryPayloadEncrypted: { not: null },
      order: { channel: "API" },
    },
    select: { id: true, orderId: true, order: { select: { userId: true, orderNumber: true, status: true, user: { select: { telegramId: true } } } } },
    orderBy: { fulfilledAt: "asc" },
    take: limit,
  });
  if (rows.length === 0) return { sent: 0, failed: 0 };
  const byOrder = new Map<string, typeof rows>();
  for (const r of rows) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
  const redis = getRedis();
  let sent = 0, failed = 0;
  for (const [orderId, items] of byOrder) {
    const first = items[0]!;
    const ids = items.map((i) => i.id);
    const markDone = () => prisma.orderItem.updateMany({ where: { id: { in: ids }, apiNotifiedAt: null }, data: { apiNotifiedAt: new Date() } });
    const hook = await getApiWebhook(first.order.userId);
    if (!hook) { await markDone(); continue; }
    if (await redis.exists(`apiwh:back:${orderId}`).catch(() => 0)) continue;
    const detail = await apiOrderDetail(first.order.userId, orderId);
    const fresh = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    const newItems = detail.items.filter((i) => i.id && ids.includes(i.id));
    const r = await postWebhook(hook, "order.delivered", {
      orderNumber: first.order.orderNumber,
      status: fresh?.status ?? first.order.status,
      items: newItems,
      deliveries: newItems,
      deliveryText: formatApiDeliveryText(newItems),
      pendingItems: detail.pendingItems,
    });
    if (r.ok) { await markDone(); sent++; continue; }
    failed++;
    const tries = await redis.incr(`apiwh:try:${orderId}`).catch(() => MAX_TRIES);
    await redis.expire(`apiwh:try:${orderId}`, 3 * 86400).catch(() => undefined);
    if (tries >= MAX_TRIES) {
      await markDone();
      const tg = first.order.user.telegramId;
      if (tg !== null) {
        await enqueueTelegramMessage(tg, [
          `⚠️ <b>Webhook failed</b> for API order <code>${first.order.orderNumber}</code>`,
          `Your server did not accept the delivery after ${MAX_TRIES} tries (${(r.status ? `HTTP ${r.status}` : r.error ?? "no answer").replace(/</g, "&lt;")}).`,
          "The items are in 📦 My Orders and in <code>GET /orders/" + first.order.orderNumber + "</code>.",
        ].join("\n")).catch(() => undefined);
      }
    } else {
      await redis.set(`apiwh:back:${orderId}`, "1", "EX", Math.min(3600, 30 * 2 ** (tries - 1))).catch(() => undefined);
    }
  }
  return { sent, failed };
}

