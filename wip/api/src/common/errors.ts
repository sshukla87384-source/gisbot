import { HttpException } from "@nestjs/common";

/**
 * HttpException carrying a stable machine code + optional details,
 * rendered by the global filter into the doc's error envelope (API spec §1.2).
 */
export class ApiError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message, status);
  }
}

export const notFound = (entity: string): ApiError => new ApiError(404, "NOT_FOUND", `${entity} not found.`);

export const conflict = (code: string, message: string): ApiError => new ApiError(409, code, message);

export const unauthenticated = (message = "Authentication required."): ApiError =>
  new ApiError(401, "UNAUTHENTICATED", message);

export const forbidden = (message = "You do not have permission to perform this action."): ApiError =>
  new ApiError(403, "FORBIDDEN", message);
