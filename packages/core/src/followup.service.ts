import { prisma } from "@gis/database";
import { enqueueTelegramMessage, type OutboxButton } from "./queues.js";

/**
 * After-sale follow-up: a message sent some time AFTER an order is delivered —
 * typically a review request, tagged with that order, or a promo.
 */
const KEY = "delivery.followup";

export interface FollowupConfig {
  enabled: boolean;
  delayMins: number;
  text: string;
  btnText?: string | null;
  btnUrl?: string | null;
}

const DEFAULT_TEXT = [
  "🌟 <b>How was your order, {name}?</b>",
  "",
  "🧾 Order <b>{order}</b> — {product}",
  "",
  "If everything worked, a quick review really helps us. If anything is wrong, just reply here and we'll fix it. 🙏",
].join("\n");

export async function getFollowupConfig(): Promise<FollowupConfig> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } }).catch(() => null);
  const v = (row?.value ?? null) as Partial<FollowupConfig> | null;
  return {
    enabled: v?.enabled ?? false,
    delayMins: Number(v?.delayMins ?? 60),
    text: v?.text ?? DEFAULT_TEXT,
    btnText: v?.btnText ?? null,
    btnUrl: v?.btnUrl ?? null,
  };
}

export async function setFollowupConfig(patch: Partial<FollowupConfig>): Promise<FollowupConfig> {
  const cur = await getFollowupConfig();
  const next = { ...cur, ...patch };
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: next as never }, update: { value: next as never } });
  return next;
}

/** Placeholders an admin can use in the follow-up text. */
export function renderFollowup(tpl: string, vars: { name: string; order: string; product: string; store: string }): string {
  return tpl
    .replace(/\{name\}/g, vars.name)
    .replace(/\{order\}/g, vars.order)
    .replace(/\{product\}/g, vars.product)
    .replace(/\{store\}/g, vars.store);
}

/** Queue the follow-up for a delivered order. Never throws. */
export async function scheduleFollowup(orderId: string, storeName: string): Promise<boolean> {
  try {
    const cfg = await getFollowupConfig();
    if (!cfg.enabled || !cfg.text.trim()) return false;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { select: { telegramId: true, telegramHandle: true, firstName: true } },
        items: { select: { productNameSnap: true }, take: 3 },
      },
    });
    if (!order?.user.telegramId) return false;
    const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const name = esc(order.user.firstName ?? (order.user.telegramHandle ? `@${order.user.telegramHandle}` : "there"));
    const products = [...new Set(order.items.map((i) => i.productNameSnap))];
    const product = esc(products.slice(0, 2).join(", ") + (products.length > 2 ? ` +${products.length - 2} more` : ""));
    const text = renderFollowup(cfg.text, { name, order: esc(order.orderNumber), product, store: esc(storeName) });
    const buttons: OutboxButton[] | undefined =
      cfg.btnText && cfg.btnUrl ? [{ text: cfg.btnText, url: cfg.btnUrl, style: "success" }] : undefined;
    await enqueueTelegramMessage(order.user.telegramId, text, { buttons, delayMs: Math.max(0, cfg.delayMins) * 60_000 });
    return true;
  } catch {
    return false;
  }
}
