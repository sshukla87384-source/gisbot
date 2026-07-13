import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { map, type Observable } from "rxjs";
import { Paginated } from "./pagination.js";
import { SKIP_ENVELOPE_METADATA, readMetadata } from "./permissions.decorator.js";
import { toJsonSafe } from "./types.js";

/**
 * Wraps successful responses in the API envelope (API spec §1.2):
 *   { success: true, data, meta? }
 * Paginated<T> results contribute `meta`. BigInt values are made JSON-safe.
 * Routes marked @SkipEnvelope (webhook acks, HTML) pass through untouched.
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = readMetadata<boolean>(SKIP_ENVELOPE_METADATA, context.getHandler(), context.getClass());
    return next.handle().pipe(
      map((payload) => {
        if (skip) return payload;
        if (payload instanceof Paginated) {
          return { success: true, data: toJsonSafe(payload.data), meta: payload.meta };
        }
        return { success: true, data: toJsonSafe(payload) };
      }),
    );
  }
}
