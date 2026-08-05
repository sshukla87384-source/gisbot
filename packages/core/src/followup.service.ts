import { prisma } from "@gis/database";
import { enqueueTelegramMessage, type OutboxButton } from "./queues.js";
import { cached, invalidate } from "./redis.js";

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
    delayMins: Number(v?.delayMins ?? 10),
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
    // Default to an IN-BOT review button so the rating is captured here and we
    // can thank them instantly. A custom link replaces it when one is set.
    const buttons: OutboxButton[] = cfg.btnText && cfg.btnUrl
      ? [{ text: cfg.btnText, url: cfg.btnUrl, style: "success" }]
      : [{ text: "⭐ Leave a review", callbackData: `rev:new:${order.id}`, style: "success" }];
    await enqueueTelegramMessage(order.user.telegramId, text, { buttons, delayMs: Math.max(0, cfg.delayMins) * 60_000 });
    return true;
  } catch {
    return false;
  }
}

/* ── Reviews & moderation ─────────────────────────────────────────────────── */

const RATING_CACHE_TTL = 300;
const PUBLISHED = { status: "APPROVED" as const };

/**
 * Save a customer's rating. One per completed order (unique on `orderId`).
 * The rating value and comment are written ONLY from the customer's own input —
 * no admin path ever updates them. Nothing is published until approved.
 */
export async function saveReview(
  userId: string,
  rating: number,
  orderId?: string,
  comment?: string,
): Promise<{ id: string; alreadyRated: boolean }> {
  const value = Math.min(5, Math.max(1, Math.round(rating)));
  let productId: string | null = null;
  let verified = false;
  if (orderId) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { status: true, items: { select: { variant: { select: { productId: true } }, fulfilledAt: true }, take: 1 } },
    });
    if (!order) throw new Error("ORDER_NOT_FOUND");
    if (!["COMPLETED", "PAID", "PENDING_FULFILLMENT"].includes(order.status)) throw new Error("ORDER_NOT_ELIGIBLE");
    productId = order.items[0]?.variant.productId ?? null;
    // Verified = they actually paid for it and something was delivered.
    verified = order.status === "COMPLETED" || Boolean(order.items[0]?.fulfilledAt);
  }
  const existing = orderId ? await prisma.review.findUnique({ where: { orderId } }) : null;
  const row = existing
    ? await prisma.review.update({
        where: { id: existing.id },
        // Re-rating resets moderation — the new value must be reviewed again.
        data: { rating: value, ...(comment ? { comment: comment.slice(0, 1000) } : {}), status: "PENDING", reviewedBy: null, reviewedAt: null, rejectReason: null },
      })
    : await prisma.review.create({
        data: { userId, rating: value, orderId: orderId || null, productId, comment: comment?.slice(0, 1000) || null, verifiedPurchase: verified },
      });
  await bustRatingCache(productId);
  return { id: row.id, alreadyRated: Boolean(existing) };
}

export async function addReviewComment(reviewId: string, comment: string): Promise<void> {
  const r = await prisma.review
    .update({ where: { id: reviewId }, data: { comment: comment.slice(0, 1000), status: "PENDING" } })
    .catch(() => null);
  if (r) await bustRatingCache(r.productId);
}

export async function orderAlreadyRated(orderId: string): Promise<boolean> {
  if (!orderId) return false;
  return (await prisma.review.findUnique({ where: { orderId }, select: { id: true } })) !== null;
}

async function bustRatingCache(productId?: string | null): Promise<void> {
  await invalidate("rating:*").catch(() => undefined);
  if (productId) await invalidate(`rating:p:${productId}`).catch(() => undefined);
}

export interface RatingSummary { count: number; avg: number; stars: string }

function starsFor(avg: number): string {
  return "⭐".repeat(Math.max(1, Math.min(5, Math.floor(avg + 0.25))));
}

/** Store-wide rating — APPROVED reviews only. Cached. */
export async function storeRating(): Promise<RatingSummary> {
  return cached("rating:store", RATING_CACHE_TTL, async () => {
    const a = await prisma.review.aggregate({ where: PUBLISHED, _count: { _all: true }, _avg: { rating: true } });
    const avg = Math.round((a._avg.rating ?? 0) * 10) / 10;
    return { count: a._count._all, avg, stars: starsFor(avg) };
  });
}

/** Per-product rating — APPROVED reviews only. Cached. */
export async function productRating(productId: string): Promise<RatingSummary> {
  return cached(`rating:p:${productId}`, RATING_CACHE_TTL, async () => {
    const a = await prisma.review.aggregate({ where: { productId, ...PUBLISHED }, _count: { _all: true }, _avg: { rating: true } });
    const avg = Math.round((a._avg.rating ?? 0) * 10) / 10;
    return { count: a._count._all, avg, stars: starsFor(avg) };
  });
}

/** Ratings for many products in one query. */
export async function productRatings(productIds: string[]): Promise<Map<string, RatingSummary>> {
  const out = new Map<string, RatingSummary>();
  if (productIds.length === 0) return out;
  const rows = await prisma.review.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds }, ...PUBLISHED },
    _count: { _all: true },
    _avg: { rating: true },
  });
  for (const r of rows) {
    if (!r.productId) continue;
    const avg = Math.round((r._avg.rating ?? 0) * 10) / 10;
    out.set(r.productId, { count: r._count._all, avg, stars: starsFor(avg) });
  }
  return out;
}

/** Approved reviews shown to customers on a product card. */
export async function publicReviews(productId: string, limit = 3): Promise<Array<{ who: string; rating: number; comment: string | null; verified: boolean; reply: string | null; at: Date }>> {
  const rows = await prisma.review.findMany({
    where: { productId, ...PUBLISHED, comment: { not: null } },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { firstName: true, telegramHandle: true } } },
  });
  return rows.map((r) => ({
    who: r.user.firstName ?? (r.user.telegramHandle ? `@${r.user.telegramHandle}` : "Customer"),
    rating: r.rating,
    comment: r.comment,
    verified: r.verifiedPurchase,
    reply: r.adminReply,
    at: r.createdAt,
  }));
}

export interface ReviewRow {
  id: string; who: string; telegramId: string; rating: number; comment: string | null;
  status: string; verified: boolean; reply: string | null; rejectReason: string | null;
  product: string | null; at: Date;
}

/** Paginated moderation list. */
export async function listReviews(
  page = 1,
  pageSize = 6,
  filter: "pending" | "approved" | "rejected" | "all" = "pending",
): Promise<{ rows: ReviewRow[]; page: number; pages: number; total: number; pending: number }> {
  const where = filter === "all" ? {} : { status: filter.toUpperCase() as "PENDING" | "APPROVED" | "REJECTED" };
  const [total, pending, rows] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.count({ where: { status: "PENDING" } }),
    prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (Math.max(1, page) - 1) * pageSize,
      take: pageSize,
      include: { user: { select: { telegramHandle: true, firstName: true, telegramId: true } } },
    }),
  ]);
  const pids = [...new Set(rows.map((r) => r.productId).filter((x): x is string => Boolean(x)))];
  const names = pids.length
    ? new Map((await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]))
    : new Map<string, string>();
  return {
    total,
    pending,
    page: Math.max(1, page),
    pages: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((r) => ({
      id: r.id,
      who: r.user.telegramHandle ? `@${r.user.telegramHandle}` : (r.user.firstName ?? "customer"),
      telegramId: String(r.user.telegramId ?? ""),
      rating: r.rating,
      comment: r.comment,
      status: r.status,
      verified: r.verifiedPurchase,
      reply: r.adminReply,
      rejectReason: r.rejectReason,
      product: r.productId ? (names.get(r.productId) ?? null) : null,
      at: r.createdAt,
    })),
  };
}

export async function getReview(id: string): Promise<ReviewRow | null> {
  const r = await prisma.review.findUnique({ where: { id }, include: { user: { select: { telegramHandle: true, firstName: true, telegramId: true } } } });
  if (!r) return null;
  const name = r.productId ? (await prisma.product.findUnique({ where: { id: r.productId }, select: { name: true } }))?.name ?? null : null;
  return {
    id: r.id, who: r.user.telegramHandle ? `@${r.user.telegramHandle}` : (r.user.firstName ?? "customer"),
    telegramId: String(r.user.telegramId ?? ""), rating: r.rating, comment: r.comment, status: r.status,
    verified: r.verifiedPurchase, reply: r.adminReply, rejectReason: r.rejectReason, product: name, at: r.createdAt,
  };
}

async function audit(reviewId: string, action: string, actor: string, reason?: string): Promise<void> {
  await prisma.reviewModeration.create({ data: { reviewId, action, actor, reason: reason ?? null } }).catch(() => undefined);
}

/** Approve — the review becomes public and starts counting toward averages. */
export async function approveReview(id: string, actor = "bot-admin"): Promise<boolean> {
  const r = await prisma.review
    .update({ where: { id }, data: { status: "APPROVED", reviewedBy: actor, reviewedAt: new Date(), rejectReason: null } })
    .catch(() => null);
  if (!r) return false;
  await audit(id, "APPROVED", actor);
  await bustRatingCache(r.productId);
  return true;
}

export const REJECT_REASONS = ["Spam", "Abusive language", "Duplicate", "Irrelevant"] as const;

/** Reject — never published, never counted. The customer's words are preserved. */
export async function rejectReview(id: string, reason: string, actor = "bot-admin"): Promise<boolean> {
  const r = await prisma.review
    .update({ where: { id }, data: { status: "REJECTED", reviewedBy: actor, reviewedAt: new Date(), rejectReason: reason.slice(0, 200) } })
    .catch(() => null);
  if (!r) return false;
  await audit(id, "REJECTED", actor, reason);
  await bustRatingCache(r.productId);
  return true;
}

/** Public reply from the store. Does not touch the customer's rating or text. */
export async function replyToReview(id: string, reply: string, actor = "bot-admin"): Promise<boolean> {
  const r = await prisma.review.update({ where: { id }, data: { adminReply: reply.slice(0, 1000) } }).catch(() => null);
  if (!r) return false;
  await audit(id, "REPLIED", actor, reply.slice(0, 120));
  await bustRatingCache(r.productId);
  return true;
}

export async function setVerifiedPurchase(id: string, verified: boolean, actor = "bot-admin"): Promise<boolean> {
  const r = await prisma.review.update({ where: { id }, data: { verifiedPurchase: verified } }).catch(() => null);
  if (!r) return false;
  await audit(id, "VERIFIED", actor, verified ? "marked verified" : "unmarked");
  await bustRatingCache(r.productId);
  return true;
}

export async function moderationLog(reviewId: string, limit = 10): Promise<Array<{ action: string; reason: string | null; actor: string; at: Date }>> {
  const rows = await prisma.reviewModeration.findMany({ where: { reviewId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => ({ action: r.action, reason: r.reason, actor: r.actor, at: r.createdAt }));
}

export async function ratingBreakdown(): Promise<{ stars: number; count: number }[]> {
  return cached("rating:breakdown", RATING_CACHE_TTL, async () => {
    const rows = await prisma.review.groupBy({ by: ["rating"], where: PUBLISHED, _count: { _all: true } });
    const byStar = new Map(rows.map((r) => [r.rating, r._count._all]));
    return [5, 4, 3, 2, 1].map((stars) => ({ stars, count: byStar.get(stars) ?? 0 }));
  });
}

export async function reviewStats(): Promise<{ count: number; avg: number }> {
  const s = await storeRating();
  return { count: s.count, avg: s.avg };
}
