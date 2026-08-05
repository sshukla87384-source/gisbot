import { prisma } from "@gis/database";
import { cached, invalidate } from "./redis.js";
import { enqueueTelegramMessage, enqueueAdminAlert } from "./queues.js";
import { convertMinor } from "./fx.js";
import type { Currency } from "@gis/database";

/**
 * Loyalty tiers from real lifetime spend, plus admin-sent gifts.
 *
 * Gifts are NOTIFY-ONLY by design: the bot tells the customer a gift is coming,
 * the admin delivers it by hand and marks it delivered. Nothing is auto-issued.
 */

const TTL = 120;
const KEY = "loyalty.tiers";

export interface TierDef { name: string; minSpendMinor: number; perk: string }

const DEFAULT_TIERS: TierDef[] = [
  { name: "Bronze", minSpendMinor: 0, perk: "Member pricing" },
  { name: "Silver", minSpendMinor: 5_000, perk: "Priority support" },
  { name: "Gold", minSpendMinor: 25_000, perk: "Priority support + gifts" },
];

export async function getTiers(): Promise<TierDef[]> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } }).catch(() => null);
  const v = row?.value as TierDef[] | null;
  if (!Array.isArray(v) || v.length === 0) return DEFAULT_TIERS;
  return [...v].sort((a, b) => a.minSpendMinor - b.minSpendMinor);
}

export async function setTiers(tiers: TierDef[]): Promise<void> {
  const clean = tiers
    .filter((t) => t.name.trim())
    .map((t) => ({ name: t.name.trim().slice(0, 24), minSpendMinor: Math.max(0, Math.round(t.minSpendMinor)), perk: (t.perk ?? "").slice(0, 80) }))
    .sort((a, b) => a.minSpendMinor - b.minSpendMinor);
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: clean as never }, update: { value: clean as never } });
  await invalidate("loyal:*").catch(() => undefined);
}

/** Lifetime spend on COMPLETED orders, in the customer's wallet currency. */
export async function lifetimeSpend(userId: string): Promise<{ minor: number; currency: Currency }> {
  return cached(`loyal:spend:${userId}`, TTL, async () => {
    const w = await prisma.wallet.findUnique({ where: { userId }, select: { currency: true } });
    const currency = (w?.currency ?? "USD") as Currency;
    const orders = await prisma.order.findMany({
      where: { userId, status: "COMPLETED" },
      select: { subtotalMinor: true, discountMinor: true, currency: true },
    });
    let minor = 0;
    for (const o of orders) {
      const paid = Math.max(0, o.subtotalMinor - o.discountMinor);
      minor += o.currency === currency ? paid : convertMinor(paid, o.currency as Currency, currency);
    }
    return { minor, currency };
  });
}

export interface TierStatus {
  tier: TierDef;
  next: TierDef | null;
  spendMinor: number;
  currency: Currency;
  toNextMinor: number;
  progressPct: number;
}

export async function tierOf(userId: string): Promise<TierStatus> {
  const [tiers, spend] = await Promise.all([getTiers(), lifetimeSpend(userId)]);
  let tier = tiers[0] ?? DEFAULT_TIERS[0]!;
  for (const t of tiers) if (spend.minor >= t.minSpendMinor) tier = t;
  const next = tiers.find((t) => t.minSpendMinor > spend.minor) ?? null;
  const toNext = next ? Math.max(0, next.minSpendMinor - spend.minor) : 0;
  const span = next ? next.minSpendMinor - tier.minSpendMinor : 1;
  return {
    tier,
    next,
    spendMinor: spend.minor,
    currency: spend.currency,
    toNextMinor: toNext,
    progressPct: next ? Math.min(100, Math.round(((spend.minor - tier.minSpendMinor) / Math.max(1, span)) * 100)) : 100,
  };
}

/** Tell a customer when they reach a new tier. Called after a completed order. */
export async function notifyTierChange(userId: string): Promise<void> {
  try {
    const before = await prisma.setting.findUnique({ where: { key: `loyalty.last:${userId}` } }).catch(() => null);
    await invalidate(`loyal:spend:${userId}`).catch(() => undefined);
    const st = await tierOf(userId);
    const prev = (before?.value as { tier?: string } | null)?.tier;
    if (prev === st.tier.name) return;
    await prisma.setting.upsert({
      where: { key: `loyalty.last:${userId}` },
      create: { key: `loyalty.last:${userId}`, value: { tier: st.tier.name } as never },
      update: { value: { tier: st.tier.name } as never },
    });
    if (!prev) return; // first calculation — don't congratulate on signup
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true, firstName: true } });
    if (!u?.telegramId) return;
    await enqueueTelegramMessage(
      u.telegramId,
      [
        `🏆 <b>You're now ${st.tier.name}!</b>`,
        "",
        `Thank you for your support${u.firstName ? `, ${u.firstName}` : ""} — you've unlocked <b>${st.tier.perk}</b>.`,
        st.next ? `\n📈 ${((st.next.minSpendMinor - st.spendMinor) / 100).toFixed(2)} more to reach <b>${st.next.name}</b>.` : "\n👑 You're at the top tier.",
      ].join("\n"),
    );
  } catch {
    /* never break an order over a congratulation */
  }
}

/* ── Gifts: notify only, delivered by hand ────────────────────────────────── */

export async function createGift(userId: string, title: string, detail: string | null, actor: string): Promise<{ ok: boolean }> {
  const st = await tierOf(userId).catch(() => null);
  const g = await prisma.loyaltyGift.create({
    data: { userId, title: title.slice(0, 120), detail: detail?.slice(0, 1000) ?? null, tierAtGrant: st?.tier.name ?? null, createdBy: actor },
  });
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true, firstName: true } });
  if (u?.telegramId) {
    await enqueueTelegramMessage(
      u.telegramId,
      [
        "🎁 <b>You have a gift from us!</b>",
        "",
        `<b>${title.slice(0, 120)}</b>`,
        detail ? `\n${detail.slice(0, 500)}` : "",
        "",
        "🙏 A thank-you for being a valued customer. Our team is arranging it and will send it here shortly.",
      ].filter(Boolean).join("\n"),
    ).catch(() => undefined);
  }
  await enqueueAdminAlert(
    ["🎁 <b>Gift created — deliver by hand</b>", `👤 ${u?.firstName ?? userId}`, `🏷 ${title.slice(0, 80)}`, "", "Mark it delivered in Users → Gifts once sent."].join("\n"),
  ).catch(() => undefined);
  return { ok: Boolean(g.id) };
}

export interface GiftRow { id: string; who: string; telegramId: string; title: string; detail: string | null; status: string; tier: string | null; at: Date }

export async function listGifts(status: "PENDING" | "DELIVERED" | "ALL" = "PENDING", limit = 15): Promise<GiftRow[]> {
  const rows = await prisma.loyaltyGift.findMany({
    where: status === "ALL" ? {} : { status },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { firstName: true, telegramHandle: true, telegramId: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    who: r.user.telegramHandle ? `@${r.user.telegramHandle}` : (r.user.firstName ?? "customer"),
    telegramId: String(r.user.telegramId ?? ""),
    title: r.title,
    detail: r.detail,
    status: r.status,
    tier: r.tierAtGrant,
    at: r.createdAt,
  }));
}

export async function markGiftDelivered(id: string, actor: string): Promise<boolean> {
  const g = await prisma.loyaltyGift
    .update({ where: { id }, data: { status: "DELIVERED", deliveredBy: actor, deliveredAt: new Date() }, include: { user: { select: { telegramId: true } } } })
    .catch(() => null);
  if (!g) return false;
  if (g.user.telegramId) {
    await enqueueTelegramMessage(g.user.telegramId, `🎁 <b>Your gift has been sent!</b>\n\n<b>${g.title}</b>\n\nEnjoy — and thank you for being with us. 🙏`).catch(() => undefined);
  }
  return true;
}
