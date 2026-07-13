import { z } from "zod";

/** List query grammar (API spec §1.3): page/perPage/sort/search/filter[...]. */
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().max(200).optional(),
  search: z.string().max(200).optional(),
  filter: z.record(z.union([z.string(), z.record(z.string())])).default({}),
});

export interface ListMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** Marker wrapper the envelope interceptor unwraps into { data, meta }. */
export class Paginated<T> {
  constructor(
    public readonly data: T,
    public readonly meta: ListMeta,
  ) {}
}

export function buildMeta(page: number, perPage: number, total: number): ListMeta {
  return { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) };
}

export function paginated<T>(data: T, page: number, perPage: number, total: number): Paginated<T> {
  return new Paginated(data, buildMeta(page, perPage, total));
}

export interface ParsedList {
  page: number;
  perPage: number;
  skip: number;
  take: number;
  search?: string;
  /** filter[key]=value or filter[key][gte]=value */
  filter: Record<string, string | Record<string, string>>;
  /** whitelisted -field,field grammar mapped to Prisma orderBy */
  orderBy: Array<Record<string, "asc" | "desc">>;
}

/**
 * Parse the standard list query. `sortable` is the whitelist of sort fields;
 * non-whitelisted fields are silently dropped (never trusted into Prisma).
 */
export function parseList(query: unknown, sortable: readonly string[], defaultSort = "-createdAt"): ParsedList {
  const q = listQuerySchema.parse(query ?? {});
  const orderBy: Array<Record<string, "asc" | "desc">> = [];
  for (const part of (q.sort ?? defaultSort).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const desc = trimmed.startsWith("-");
    const field = desc ? trimmed.slice(1) : trimmed;
    if (sortable.includes(field)) orderBy.push({ [field]: desc ? "desc" : "asc" });
  }
  if (orderBy.length === 0) {
    const desc = defaultSort.startsWith("-");
    orderBy.push({ [desc ? defaultSort.slice(1) : defaultSort]: desc ? "desc" : "asc" });
  }
  return {
    page: q.page,
    perPage: q.perPage,
    skip: (q.page - 1) * q.perPage,
    take: q.perPage,
    search: q.search?.trim() || undefined,
    filter: q.filter,
    orderBy,
  };
}

/** Extract a plain string filter value (ignores nested operator objects). */
export function filterValue(list: ParsedList, key: string): string | undefined {
  const v = list.filter[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Extract a { gte?, lte? } date-range filter as Date objects (invalid dates dropped). */
export function filterDateRange(list: ParsedList, key: string): { gte?: Date; lte?: Date } | undefined {
  const v = list.filter[key];
  if (!v || typeof v === "string") return undefined;
  const range: { gte?: Date; lte?: Date } = {};
  for (const op of ["gte", "lte"] as const) {
    const raw = v[op];
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) range[op] = d;
  }
  return range.gte || range.lte ? range : undefined;
}
