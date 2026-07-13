import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { requireJwtSecret } from "@gis/config";
import { jwtVerify } from "jose";
import { unauthenticated } from "./errors.js";
import { PUBLIC_METADATA, readMetadata } from "./permissions.decorator.js";
import type { ApiRequest, AuthUser } from "./types.js";

let secret: Uint8Array | undefined;
function jwtKey(): Uint8Array {
  if (!secret) secret = new TextEncoder().encode(requireJwtSecret());
  return secret;
}

/**
 * Bearer JWT guard (HS256 via jose). Registered globally; routes marked
 * `@Public()` are skipped. Attaches `req.user = { id, roles, perms }`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (readMetadata<boolean>(PUBLIC_METADATA, context.getHandler(), context.getClass())) return true;

    const req = context.switchToHttp().getRequest<ApiRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthenticated();

    try {
      const { payload } = await jwtVerify(header.slice("Bearer ".length), jwtKey(), {
        audience: "admin",
        algorithms: ["HS256"],
      });
      if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("missing sub");
      const user: AuthUser = {
        id: payload.sub,
        roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
        perms: Array.isArray(payload.perms) ? (payload.perms as string[]) : [],
      };
      req.user = user;
      return true;
    } catch {
      throw unauthenticated("Invalid or expired access token.");
    }
  }
}
