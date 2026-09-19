import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { forbidden, unauthenticated } from "./errors.js";
import {
  PERMISSIONS_METADATA,
  PUBLIC_METADATA,
  SELF_SCOPED_METADATA,
  readMetadata,
} from "./permissions.decorator.js";
import type { ApiRequest } from "./types.js";

/**
 * RBAC guard (Security doc §2): the route's `@RequirePermission` keys are matched
 * against the `perms` JWT claim; any match grants access; SUPER_ADMIN bypasses.
 *
 * Fails CLOSED: a route that carries no `@RequirePermission`, `@Public` or
 * `@SelfScoped` metadata is denied outright, so forgetting the decorator on a
 * new route can never silently publish it to every authenticated admin.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const cls = context.getClass();
    if (readMetadata<boolean>(PUBLIC_METADATA, handler, cls)) return true;

    const req = context.switchToHttp().getRequest<ApiRequest>();
    const user = req.user;
    if (!user) throw unauthenticated();

    // Authenticated-only routes that act solely on the caller's own record.
    if (readMetadata<boolean>(SELF_SCOPED_METADATA, handler, cls)) return true;

    const required = readMetadata<string[]>(PERMISSIONS_METADATA, handler, cls);
    if (!required || required.length === 0) throw forbidden();

    if (user.roles.includes("SUPER_ADMIN")) return true;
    if (required.some((key) => user.perms.includes(key))) return true;
    throw forbidden(`Missing permission: ${required.join(" or ")}.`);
  }
}
