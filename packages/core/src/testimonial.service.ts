import { prisma } from "@gis/database";
import { cached, invalidate } from "./redis.js";

/**
 * Curated testimonials — marketing content, kept deliberately separate from the
 * `Review` model. Testimonials NEVER contribute to the public star average:
 * that is computed only from approved in-bot reviews tied to real orders
 * (see followup.service.ts). `verifiedOrderId` is derived from a real order and
 * is not settable by hand.
 */

const TTL = 300;

export type TStatus = "DRAFT" | "PENDING" | "PUBLISHED" | "ARCHIVED";

export interface TestimonialInput {
  customerName: string;
  body: string;
  rating: number;
  source: string;
  company?: string | null;
  avatarUrl?: string | null;
  productId?: string | null;
  productName?: string | null;
  locale?: string;
  featured?: boolean;
  pinned?: boolean;
  sortOrder?: number;
  status?: TStatus;
}

export interface TestimonialRow {
  id: string;
  customerName: string;
  company: string | null;
  avatarUrl: string | null;
  productName: string | null;
  rating: number;
  body: string;
  source: string;
  verified: boolean;
  status: string;
  featured: boolean;
  pinned: boolean;
  sortOrder: number;
  locale: string;
  spamScore: number;
  at: Date;
}

/** Cheap heuristic spam score (0-100). Flags for review; never auto-deletes. */
export function spamScoreOf(name: string, body: string): number {
  let s = 0;
  const t = `${name} ${body}`;
  if (/https?:\/\//i.test(body)) s += 35;
  if (/\b(t\.me|telegram\.me|whatsapp|wa\.me)\b/i.test(t)) s += 25;
  if (/(.)\1{5,}/.test(body)) s += 20; // aaaaaa
  if (body.trim().length < 15) s += 20;
  const caps = body.replace(/[^A-Z]/g, "").length / Math.max(1, body.replace(/\s/g, "").length);
  if (caps > 0.6) s += 15;
  if (/\b(buy now|cheap|free money|casino|crypto signal|investment)\b/i.test(t)) s += 25;
  return Math.min(100, s);
}

async function log(testimonialId: string, action: string, actor: string, detail?: string): Promise<void> {
  await prisma.testimonialLog.create({ data: { testimonialId, action, actor, detail: detail?.slice(0, 300) ?? null } }).catch(() => undefined);
}

const bust = async (): Promise<void> => {
  await invalidate("testi:*").catch(() => undefined);
};

function toRow(t: {
  id: string; customerName: string; company: string | null; avatarUrl: string | null; productName: string | null;
  rating: number; body: string; source: string; verifiedOrderId: string | null; status: string; featured: boolean;
  pinned: boolean; sortOrder: number; locale: string; spamScore: number; createdAt: Date;
}): TestimonialRow {
  return {
    id: t.id, customerName: t.customerName, company: t.company, avatarUrl: t.avatarUrl,
    productName: t.productName, rating: t.rating, body: t.body, source: t.source,
    verified: t.verifiedOrderId !== null, status: t.status, featured: t.featured,
    pinned: t.pinned, sortOrder: t.sortOrder, locale: t.locale, spamScore: t.spamScore, at: t.createdAt,
  };
}

export async function createTestimonial(input: TestimonialInput, actor: string): Promise<{ id: string; spamScore: number }> {
  const name = input.customerName.trim().slice(0, 120);
  const body = input.body.trim().slice(0, 2000);
  if (!name) throw new Error("NAME_REQUIRED");
  if (!body) throw new Error("BODY_REQUIRED");
  // Source is mandatory: every published quote must be traceable to real feedback.
  const source = input.source.trim().slice(0, 300);
  if (!source) throw new Error("SOURCE_REQUIRED");
  const rating = Math.min(5, Math.max(1, Math.round(input.rating)));
  const t = await prisma.testimonial.create({
    data: {
      customerName: name,
      company: input.company?.trim().slice(0, 120) || null,
      avatarUrl: input.avatarUrl?.trim() || null,
      productId: input.productId || null,
      productName: input.productName?.trim().slice(0, 200) || null,
      rating,
      body,
      source,
      locale: (input.locale || "en").slice(0, 5),
      featured: input.featured ?? false,
      pinned: input.pinned ?? false,
      sortOrder: input.sortOrder ?? 0,
      status: input.status ?? "DRAFT",
      spamScore: spamScoreOf(name, body),
      createdBy: actor,
    },
  });
  await log(t.id, "CREATED", actor, `${name} · ${rating}★`);
  await bust();
  return { id: t.id, spamScore: t.spamScore };
}

export async function updateTestimonial(id: string, patch: Partial<TestimonialInput>, actor: string): Promise<boolean> {
  const data: Record<string, unknown> = {};
  if (patch.customerName !== undefined) data.customerName = patch.customerName.trim().slice(0, 120);
  if (patch.company !== undefined) data.company = patch.company?.trim().slice(0, 120) || null;
  if (patch.avatarUrl !== undefined) data.avatarUrl = patch.avatarUrl?.trim() || null;
  if (patch.productName !== undefined) data.productName = patch.productName?.trim().slice(0, 200) || null;
  if (patch.productId !== undefined) data.productId = patch.productId || null;
  if (patch.rating !== undefined) data.rating = Math.min(5, Math.max(1, Math.round(patch.rating)));
  if (patch.body !== undefined) data.body = patch.body.trim().slice(0, 2000);
  if (patch.source !== undefined) data.source = patch.source.trim().slice(0, 300);
  if (patch.locale !== undefined) data.locale = patch.locale.slice(0, 5);
  if (patch.featured !== undefined) data.featured = patch.featured;
  if (patch.pinned !== undefined) data.pinned = patch.pinned;
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  if (patch.status !== undefined) data.status = patch.status;
  if (data.customerName || data.body) {
    const cur = await prisma.testimonial.findUnique({ where: { id }, select: { customerName: true, body: true } });
    data.spamScore = spamScoreOf(String(data.customerName ?? cur?.customerName ?? ""), String(data.body ?? cur?.body ?? ""));
  }
  const r = await prisma.testimonial.update({ where: { id }, data }).catch(() => null);
  if (!r) return false;
  await log(id, "UPDATED", actor, Object.keys(data).join(","));
  await bust();
  return true;
}

export async function setTestimonialStatus(id: string, status: TStatus, actor: string): Promise<boolean> {
  const r = await prisma.testimonial.update({ where: { id }, data: { status } }).catch(() => null);
  if (!r) return false;
  await log(id, status, actor);
  await bust();
  return true;
}

export async function toggleTestimonialFlag(id: string, flag: "featured" | "pinned", actor: string): Promise<boolean | null> {
  const cur = await prisma.testimonial.findUnique({ where: { id }, select: { featured: true, pinned: true } });
  if (!cur) return null;
  const next = !cur[flag];
  await prisma.testimonial.update({ where: { id }, data: { [flag]: next } });
  await log(id, next ? `${flag.toUpperCase()}_ON` : `${flag.toUpperCase()}_OFF`, actor);
  await bust();
  return next;
}

export async function setTestimonialOrder(id: string, order: number, actor: string): Promise<boolean> {
  const r = await prisma.testimonial.update({ where: { id }, data: { sortOrder: Math.round(order) } }).catch(() => null);
  if (!r) return false;
  await log(id, "REORDERED", actor, String(order));
  await bust();
  return true;
}

export async function deleteTestimonial(id: string, actor: string): Promise<boolean> {
  await log(id, "DELETED", actor);
  const r = await prisma.testimonial.delete({ where: { id } }).catch(() => null);
  await bust();
  return r !== null;
}

/** Admin list: search, status filter, pagination. */
export async function listTestimonials(opts: {
  page?: number; pageSize?: number; status?: TStatus | "ALL"; search?: string; locale?: string;
} = {}): Promise<{ rows: TestimonialRow[]; page: number; pages: number; total: number; counts: Record<string, number> }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = opts.pageSize ?? 6;
  const where = {
    ...(opts.status && opts.status !== "ALL" ? { status: opts.status } : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.search
      ? { OR: [
          { customerName: { contains: opts.search, mode: "insensitive" as const } },
          { body: { contains: opts.search, mode: "insensitive" as const } },
          { productName: { contains: opts.search, mode: "insensitive" as const } },
        ] }
      : {}),
  };
  const [total, rows, grouped] = await Promise.all([
    prisma.testimonial.count({ where }),
    prisma.testimonial.findMany({
      where,
      orderBy: [{ pinned: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.testimonial.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const counts: Record<string, number> = { DRAFT: 0, PENDING: 0, PUBLISHED: 0, ARCHIVED: 0 };
  for (const g of grouped) counts[g.status] = g._count._all;
  return { rows: rows.map(toRow), page, pages: Math.max(1, Math.ceil(total / pageSize)), total, counts };
}

export async function getTestimonial(id: string): Promise<TestimonialRow | null> {
  const t = await prisma.testimonial.findUnique({ where: { id } });
  return t ? toRow(t) : null;
}

/** Published testimonials for customers. Cached. */
export async function publishedTestimonials(opts: { productId?: string; locale?: string; limit?: number } = {}): Promise<TestimonialRow[]> {
  const key = `testi:pub:${opts.productId ?? "all"}:${opts.locale ?? "any"}:${opts.limit ?? 5}`;
  return cached(key, TTL, async () => {
    const rows = await prisma.testimonial.findMany({
      where: {
        status: "PUBLISHED",
        ...(opts.productId ? { productId: opts.productId } : {}),
        ...(opts.locale ? { locale: opts.locale } : {}),
      },
      orderBy: [{ pinned: "desc" }, { featured: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
      take: opts.limit ?? 5,
    });
    return rows.map(toRow);
  });
}

export async function testimonialLog(id: string, limit = 8): Promise<Array<{ action: string; detail: string | null; actor: string; at: Date }>> {
  const rows = await prisma.testimonialLog.findMany({ where: { testimonialId: id }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => ({ action: r.action, detail: r.detail, actor: r.actor, at: r.createdAt }));
}

/** Analytics for the admin dashboard. */
export async function testimonialStats(): Promise<{
  total: number; published: number; pending: number; draft: number; archived: number;
  avgShown: number; flagged: number; byLocale: Array<{ locale: string; count: number }>;
}> {
  return cached("testi:stats", TTL, async () => {
    const [grouped, pub, flagged, locales] = await Promise.all([
      prisma.testimonial.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.testimonial.aggregate({ where: { status: "PUBLISHED" }, _avg: { rating: true }, _count: { _all: true } }),
      prisma.testimonial.count({ where: { spamScore: { gte: 40 } } }),
      prisma.testimonial.groupBy({ by: ["locale"], _count: { _all: true } }),
    ]);
    const g = (k: string): number => grouped.find((x) => x.status === k)?._count._all ?? 0;
    return {
      total: grouped.reduce((n, x) => n + x._count._all, 0),
      published: g("PUBLISHED"), pending: g("PENDING"), draft: g("DRAFT"), archived: g("ARCHIVED"),
      avgShown: Math.round((pub._avg.rating ?? 0) * 10) / 10,
      flagged,
      byLocale: locales.map((l) => ({ locale: l.locale, count: l._count._all })),
    };
  });
}

/** Export every testimonial as JSON (backup / migration). */
export async function exportTestimonials(): Promise<string> {
  const rows = await prisma.testimonial.findMany({ orderBy: { createdAt: "asc" } });
  return JSON.stringify(rows.map(toRow), null, 2);
}

/** Import from the same JSON shape. Skips rows without a source. */
export async function importTestimonials(json: string, actor: string): Promise<{ added: number; skipped: number }> {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("BAD_JSON"); }
  if (!Array.isArray(parsed)) throw new Error("BAD_JSON");
  let added = 0, skipped = 0;
  for (const raw of parsed as Array<Record<string, unknown>>) {
    const name = String(raw.customerName ?? "").trim();
    const body = String(raw.body ?? "").trim();
    const source = String(raw.source ?? "").trim();
    if (!name || !body || !source) { skipped++; continue; }
    await createTestimonial({
      customerName: name, body, source,
      rating: Number(raw.rating ?? 5),
      company: raw.company ? String(raw.company) : null,
      avatarUrl: raw.avatarUrl ? String(raw.avatarUrl) : null,
      productName: raw.productName ? String(raw.productName) : null,
      locale: raw.locale ? String(raw.locale) : "en",
      status: "PENDING",
    }, actor).then(() => { added++; }).catch(() => { skipped++; });
  }
  return { added, skipped };
}
