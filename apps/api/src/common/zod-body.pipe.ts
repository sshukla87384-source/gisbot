import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { ZodTypeAny, infer as ZodInfer } from "zod";
import type { ApiRequest } from "./types.js";

/**
 * `@ZBody(schema)` — parse & validate the request body with a Zod schema.
 * ZodErrors bubble to the global filter → 400 VALIDATION_FAILED envelope.
 *
 * Usage: `create(@ZBody(createProductSchema) body: z.infer<typeof createProductSchema>)`
 */
export const ZBody = createParamDecorator((schema: ZodTypeAny, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<ApiRequest>();
  return schema.parse(req.body ?? {});
});

/** `@ZQuery(schema)` — same, for the query string. */
export const ZQuery = createParamDecorator((schema: ZodTypeAny, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<ApiRequest>();
  return schema.parse(req.query ?? {});
});

/** Standalone helper for validating arbitrary values at a boundary. */
export function validate<S extends ZodTypeAny>(schema: S, value: unknown): ZodInfer<S> {
  return schema.parse(value);
}
