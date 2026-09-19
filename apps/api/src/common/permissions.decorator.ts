import { SetMetadata, type CustomDecorator } from "@nestjs/common";

export const PERMISSIONS_METADATA = "gis:permissions";
export const PUBLIC_METADATA = "gis:public";
export const SKIP_ENVELOPE_METADATA = "gis:skip-envelope";
export const SELF_SCOPED_METADATA = "gis:self-scoped";

/**
 * `@RequirePermission("orders.fulfill")` — any of the given keys grants access.
 * SUPER_ADMIN bypasses (permissions.guard).
 */
export const RequirePermission = (...keys: string[]): CustomDecorator => SetMetadata(PERMISSIONS_METADATA, keys);

/** Route reachable without a bearer token (webhooks, login, payment return page). */
export const Public = (): CustomDecorator => SetMetadata(PUBLIC_METADATA, true);

/**
 * `@SelfScoped()` — authenticated but permission-free: the handler only ever
 * touches the caller's own record (`/auth/me`, `/auth/logout-all`). Required
 * because the permissions guard denies any route carrying no permission
 * metadata at all (fail closed).
 */
export const SelfScoped = (): CustomDecorator => SetMetadata(SELF_SCOPED_METADATA, true);

/** Skip the { success, data } envelope (webhook acks, HTML pages). */
export const SkipEnvelope = (): CustomDecorator => SetMetadata(SKIP_ENVELOPE_METADATA, true);

/** Read boolean/array metadata from handler first, then controller class. */
export function readMetadata<T>(key: string, handler: object, cls: object): T | undefined {
  return (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, cls)) as T | undefined;
}
