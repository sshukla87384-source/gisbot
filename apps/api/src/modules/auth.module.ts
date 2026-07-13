import { randomBytes, createHash } from "node:crypto";
import { loadConfig, requireJwtSecret } from "@gis/config";
import { getRedis } from "@gis/core";
import { prisma } from "@gis/database";
import { Body, Controller, Get, Module, Post, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { SignJWT } from "jose";
import { z } from "zod";
import { ApiError, unauthenticated } from "../common/errors.js";
import { Public, SkipEnvelope } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest, ApiResponse } from "../common/types.js";

const REFRESH_COOKIE = "gis_refresh";
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function permsFor(userId: string): Promise<{ roles: string[]; perms: string[] }> {
  const roles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  const roleNames = roles.map((r) => r.role.name);
  const perms = new Set<string>();
  for (const r of roles) for (const rp of r.role.permissions) perms.add(rp.permission.key);
  return { roles: roleNames, perms: [...perms] };
}

async function issueAccess(userId: string, roles: string[], perms: string[]): Promise<string> {
  const cfg = loadConfig();
  return new SignJWT({ roles, perms })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setAudience("admin")
    .setIssuedAt()
    .setExpirationTime(`${cfg.JWT_ACCESS_TTL_MIN}m`)
    .sign(new TextEncoder().encode(requireJwtSecret()));
}

function setRefreshCookie(res: ApiResponse, token: string): void {
  const cfg = loadConfig();
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: cfg.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/v1/auth",
    maxAge: cfg.REFRESH_TTL_DAYS * 86_400_000,
  });
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  @Public()
  @Post("login")
  async login(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const { email, password } = validate(loginSchema, body);

    // Per-IP+email login throttle (Security doc §6): 5/min.
    const redis = getRedis();
    const rlKey = `rl:login:${req.ip}:${email}`;
    const attempts = await redis.incr(rlKey);
    if (attempts === 1) await redis.expire(rlKey, 60);
    if (attempts > 5) throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Try again shortly.");

    const user = await prisma.user.findUnique({ where: { email } });
    const genericFail = () => new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    if (!user?.passwordHash || user.status !== "ACTIVE") throw genericFail();

    const ok = await argonVerify(user.passwordHash, password).catch(() => false);
    if (!ok) throw genericFail();

    const { roles, perms } = await permsFor(user.id);
    // Panel access requires a non-customer role.
    if (!roles.some((r) => r !== "CUSTOMER")) throw new ApiError(403, "FORBIDDEN", "This account cannot access the panel.");

    const accessToken = await issueAccess(user.id, roles, perms);
    const refresh = randomBytes(32).toString("hex");
    const cfg = loadConfig();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refresh),
        familyId: randomBytes(16).toString("hex"),
        userAgent: req.headers["user-agent"],
        ip: req.ip,
        expiresAt: new Date(Date.now() + cfg.REFRESH_TTL_DAYS * 86_400_000),
      },
    });
    setRefreshCookie(res, refresh);
    return { accessToken, user: { id: user.id, email: user.email, firstName: user.firstName, roles, perms } };
  }

  @Public()
  @Post("refresh")
  async refresh(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!raw) throw unauthenticated("No refresh token.");
    const tokenHash = sha256(raw);
    const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing || existing.expiresAt < new Date()) throw unauthenticated("Refresh token expired.");

    // Reuse detection (Security doc §1.2): a revoked/replaced token → revoke whole family.
    if (existing.revokedAt || existing.replacedBy) {
      await prisma.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw unauthenticated("Refresh token reuse detected — session revoked.");
    }

    const cfg = loadConfig();
    const next = randomBytes(32).toString("hex");
    const nextHash = sha256(next);
    await prisma.$transaction([
      prisma.refreshToken.create({
        data: {
          userId: existing.userId,
          tokenHash: nextHash,
          familyId: existing.familyId,
          userAgent: req.headers["user-agent"],
          ip: req.ip,
          expiresAt: new Date(Date.now() + cfg.REFRESH_TTL_DAYS * 86_400_000),
        },
      }),
      prisma.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), replacedBy: nextHash },
      }),
    ]);
    const { roles, perms } = await permsFor(existing.userId);
    const accessToken = await issueAccess(existing.userId, roles, perms);
    setRefreshCookie(res, next);
    return { accessToken };
  }

  @Public()
  @Post("logout")
  async logout(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (raw) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: sha256(raw), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    res.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    return { ok: true };
  }

  @Get("me")
  async me(@Req() req: ApiRequest) {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw unauthenticated();
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: req.user!.roles,
      perms: req.user!.perms,
    };
  }
}

/** Password hashing helper reused by the seed. */
export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, { memoryCost: 65536, timeCost: 3, parallelism: 4 });
}

@Module({ controllers: [AuthController] })
export class AuthModule {}
