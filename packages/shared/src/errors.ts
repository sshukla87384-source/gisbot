export type CoreErrorCode =
  | "CART_EMPTY"
  | "CART_ITEM_UNAVAILABLE"
  | "PRICE_UNAVAILABLE"
  | "OUT_OF_STOCK"
  | "INSUFFICIENT_BALANCE"
  | "PRODUCT_NOT_FOUND"
  | "VARIANT_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "WALLET_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "NOT_AUTHORIZED"
  | "UNSUPPORTED_PRODUCT_TYPE"
  | "VALIDATION_FAILED";

/** Domain error with a stable machine code — mapped to user-facing copy at the edge (bot/API). */
export class CoreError extends Error {
  constructor(
    public readonly code: CoreErrorCode,
    message?: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "CoreError";
  }
}

export function isCoreError(e: unknown): e is CoreError {
  return e instanceof CoreError;
}
