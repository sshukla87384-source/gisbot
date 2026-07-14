import { prisma } from "@gis/database";
import { sha256Hex } from "@gis/shared";
import { randomBytes } from "node:crypto";
import { getRedis } from "./redis.js";

const KEY_PREFIX = "gis_live_";

/** Scopes a developer key can hold (read-only public API v1). */
export const API_SCOPES = ["catalog:read", "orders:read", "analytics:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface CreatedApiKey {
  id: string;
  apiKey: string; // full secret — shown ONCE
  prefix: string;
}

export async function createApiKey(input: {
  name: string;
  scopes: string[];
  rateLimitPerMin?: number;
  expiresAt?: Date | null;
  ownerUserId?: string;
}): Promise<CreatedApiKey> {
  const raw = KEY_PREFIX + randomBytes(24).toString("hex"); // gis_live_<48 hex>
  const keyHash = sha256Hex(raw);
  const prefix = raw.slice(0, 16);
  const scopes = input.scopes.filter((s) => (API_SCOPES as readonly string[]).includes(s));
  const rec = await prisma.apiKey.create({
    data: {
      name: input.name.slice(0, 120),
      keyHash,
      prefix,
      scopes,
      rateLimitPerMin: input.rateLimitPerMin ?? 120,
      expiresAt: input.expiresAt ?? null,
      ownerUserId: input.ownerUserId,
    },
  });
  return { id: rec.id, apiKey: raw, prefix };
}

export interface VerifiedApiKey {
  id: string;
  name: string;
  scopes: string[];
  rateLimitPerMin: number;
}

export async function verifyApiKey(raw: string): Promise<VerifiedApiKey | null> {
  const value = raw.trim();
  if (!value.startsWith(KEY_PREFIX)) return null;
  const rec = await prisma.apiKey.findUnique({ where: { keyHash: sha256Hex(value) } });
  if (!rec || rec.revokedAt) return null;
  if (rec.expiresAt && rec.expiresAt.getTime() < Date.now()) return null;
  return { id: rec.id, name: rec.name, scopes: rec.scopes, rateLimitPerMin: rec.rateLimitPerMin };
}

/** Fixed-window per-minute limiter in Redis. Returns true if within budget. */
export async function checkApiRateLimit(id: string, perMin: number): Promise<boolean> {
  const redis = getRedis();
  const bucket = `dev:rl:${id}:${Math.floor(Date.now() / 60_000)}`;
  const n = await redis.incr(bucket);
  if (n === 1) await redis.expire(bucket, 65);
  return n <= perMin;
}

export async function touchApiKey(id: string): Promise<void> {
  await prisma.apiKey
    .update({ where: { id }, data: { lastUsedAt: new Date(), callCount: { increment: 1 } } })
    .catch(() => undefined);
}

export async function listApiKeys(): Promise<
  Array<{ id: string; name: string; prefix: string; scopes: string[]; rateLimitPerMin: number; callCount: number; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; createdAt: Date }>
> {
  return prisma.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, prefix: true, scopes: true, rateLimitPerMin: true, callCount: true,
      lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true,
    },
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
}

// ───────────── Self-service (per-user) keys ─────────────

export async function listApiKeysByOwner(ownerUserId: string): Promise<
  Array<{ id: string; name: string; prefix: string; scopes: string[]; callCount: number; revokedAt: Date | null; createdAt: Date }>
> {
  return prisma.apiKey.findMany({
    where: { ownerUserId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, scopes: true, callCount: true, revokedAt: true, createdAt: true },
  });
}

/** Revoke a key only if it belongs to this owner. Returns true if revoked. */
export async function revokeApiKeyOwned(id: string, ownerUserId: string): Promise<boolean> {
  const res = await prisma.apiKey.updateMany({
    where: { id, ownerUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}
