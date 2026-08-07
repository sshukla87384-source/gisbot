/**
 * Binance Pay timing rules.
 *
 * Two independent windows, because they defend against different things:
 *
 * BINANCE_SESSION_MIN bounds how long an order stays payable. A shorter
 * session means fewer live orders exist at any moment, so there is less for a
 * stray credit to collide with.
 *
 * CLAIM_WINDOW_MIN bounds how OLD a credit may be when it settles something.
 * This is the guard that matters: without it, the poller matched on amount
 * against the last 100 transactions with no age limit, so a credit from days
 * earlier released a brand-new order nobody had paid for. Anything older than
 * this window now goes to a human instead of being auto-released.
 */
export const BINANCE_SESSION_MIN = 15;
export const CLAIM_WINDOW_MIN = 5;
export const CLAIM_WINDOW_MS = CLAIM_WINDOW_MIN * 60_000;
