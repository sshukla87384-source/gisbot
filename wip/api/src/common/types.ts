import type { Request, Response } from "express";

/** Claims attached by AuthGuard after JWT verification. */
export interface AuthUser {
  id: string;
  roles: string[];
  perms: string[];
}

/** Express request augmented by our middleware/guards. */
export type ApiRequest = Request & {
  /** request id (x-request-id echo or generated uuid) */
  id: string;
  user?: AuthUser;
  /** present on routes when NestFactory rawBody option is enabled */
  rawBody?: Buffer;
};

export type ApiResponse = Response;

/** Convert values Prisma returns into JSON-serializable ones (BigInt → number/string). */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  // Prisma Decimal & friends serialize themselves via toJSON.
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v);
  return out;
}

/** Minimal HTML escaping for Telegram HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
