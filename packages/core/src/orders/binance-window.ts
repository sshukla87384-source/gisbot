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

/**
 * UPI payment session.
 *
 * Short, so a customer cannot sit on a live order indefinitely and so the
 * amount they owe stays unambiguous for the operator checking BharatPe.
 */
export const UPI_SESSION_MIN = 5;

/**
 * Grace period for sending the UTR AFTER the session closes.
 *
 * Without this, someone who paid at 4:50 and pasted their reference at 5:30
 * would be told their order no longer exists, having genuinely paid. The order
 * is revived for the operator to review rather than auto-released, so the
 * grace costs nothing in safety — a human still confirms the money arrived.
 */
export const UPI_UTR_GRACE_MIN = 10;
