import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { isCoreError } from "@gis/shared";
import { ZodError } from "zod";
import { ApiError } from "./errors.js";
import type { ApiRequest, ApiResponse } from "./types.js";

/**
 * Global error → envelope mapper (API spec §1.2):
 *   { success: false, error: { code, message, details?, requestId } }
 * CoreError → 422, ZodError → 400, Api/HttpException passthrough, else 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<ApiResponse>();
    const req = ctx.getRequest<ApiRequest>();
    const requestId = req.id;

    let status = 500;
    let code = "INTERNAL";
    let message = "Something went wrong.";
    let details: unknown;

    if (exception instanceof ZodError) {
      status = 400;
      code = "VALIDATION_FAILED";
      message = "Request validation failed.";
      details = exception.issues.map((i) => ({ field: i.path.join("."), issue: i.message }));
    } else if (exception instanceof ApiError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (isCoreError(exception)) {
      status = 422;
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      message = typeof resp === "string" ? resp : ((resp as { message?: string }).message ?? exception.message);
      code = status === 404 ? "NOT_FOUND" : status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : "ERROR";
    } else if (exception instanceof Error) {
      // eslint-disable-next-line no-console
      console.error("unhandled error", { requestId, error: exception.message, stack: exception.stack });
    }

    res.status(status).json({ success: false, error: { code, message, details, requestId } });
  }
}
