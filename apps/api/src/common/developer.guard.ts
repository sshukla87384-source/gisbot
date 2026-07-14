import { Injectable, SetMetadata, type CanActivate, type CustomDecorator, type ExecutionContext } from "@nestjs/common";
import { checkApiRateLimit, touchApiKey, verifyApiKey, type VerifiedApiKey } from "@gis/core";
import { ApiError } from "./errors.js";
import { forbidden, unauthenticated } from "./errors.js";
import { readMetadata } from "./permissions.decorator.js";
import type { ApiRequest } from "./types.js";

export const DEV_SCOPES_METADATA = "gis:dev-scopes";

/** `@Scopes("catalog:read")` — required scope(s) for a developer-API route. */
export const Scopes = (...scopes: string[]): CustomDecorator => SetMetadata(DEV_SCOPES_METADATA, scopes);

export type DeveloperRequest = ApiRequest & { apiKey?: VerifiedApiKey };

/**
 * Authenticates the public developer API via an API key sent as
 * `X-API-Key: <key>` or `Authorization: Bearer <key>`. Enforces per-route
 * scopes and a per-key, per-minute rate limit. Applied at controller level
 * (routes are also `@Public()` so the JWT guard steps aside).
 */
@Injectable()
export class DeveloperApiGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<DeveloperRequest>();
    const headerKey = req.headers["x-api-key"];
    const fromHeader = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    const auth = req.headers.authorization;
    const raw = fromHeader ?? (auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "");

    const key = await verifyApiKey(raw ?? "");
    if (!key) throw unauthenticated("Invalid or missing API key. Send it as the 'X-API-Key' header.");

    const required = readMetadata<string[]>(DEV_SCOPES_METADATA, context.getHandler(), context.getClass()) ?? [];
    if (required.length > 0 && !required.some((s) => key.scopes.includes(s))) {
      throw forbidden(`This key is missing the required scope: ${required.join(" or ")}.`);
    }

    const within = await checkApiRateLimit(key.id, key.rateLimitPerMin);
    if (!within) throw new ApiError(429, "RATE_LIMITED", `Rate limit exceeded (${key.rateLimitPerMin}/min). Slow down.`);

    void touchApiKey(key.id);
    req.apiKey = key;
    return true;
  }
}
