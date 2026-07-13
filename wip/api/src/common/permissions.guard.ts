import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { forbidden, unauthenticated } from "./errors.js";
import { PERMISSIONS_METADATA, PUBLIC_METADATA, readMetadata } from "./permissions.decorator.js";
import type { ApiRequest } from "./types.js";

/**
 * RBAC guard (Security doc §2): the route's `@RequirePermission` keys are matched
 * against the `perms` JWT claim; any match grants access; SUPER_ADMIN bypasses.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (readMetadata<boolean>(PUBLIC_METADATA, context.getHandler(), context.getClass())) return true;

    const required = readMetadata<string[]>(PERMISSIONS_METADATA, context.getHandler(), context.getClass());
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<ApiRequest>();
    const user = req.user;
    if (!user) throw unauthenticated();
    if (user.roles.includes("SUPER_ADMIN")) return true;
    if (required.some((key) => user.perms.includes(key))) return true;
    throw forbidden(`Missing permission: ${required.join(" or ")}.`);
  }
}
