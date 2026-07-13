/**
 * Payment provider abstraction (Architecture doc §4).
 * Gateways are enabled purely by configuration; business logic consumes only
 * the normalized event shape below.
 */

export type PaymentProviderId = "razorpay" | "nowpayments";

export interface CheckoutContext {
  orderId: string;
  orderNumber: string;
  amountMinor: number;
  currency: "INR" | "USD";
  description: string;
  customerEmail?: string;
}

export interface CheckoutSession {
  /** Hosted payment page the customer opens from Telegram. */
  url: string;
  /** Gateway-side reference (payment link id / checkout session id). */
  providerRef: string;
}

export type NormalizedEventType = "payment.succeeded" | "payment.failed" | "refund.processed";

export interface NormalizedPaymentEvent {
  provider: PaymentProviderId;
  /** Gateway event id — idempotency key (unique per provider). */
  eventId: string;
  type: NormalizedEventType;
  /** Our Order id, recovered from gateway metadata/notes (null if absent). */
  orderId: string | null;
  /** Gateway payment reference (payment id / payment_intent). */
  providerRef: string | null;
  amountMinor: number | null;
  currency: string | null;
  failureReason?: string;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  readonly currencies: ReadonlyArray<"INR" | "USD">;
  createCheckout(ctx: CheckoutContext): Promise<CheckoutSession>;
  /**
   * Verify the webhook signature against the RAW request body and parse into
   * normalized events. Returns null when the signature is invalid.
   */
  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedPaymentEvent[] | null;
  refund(providerRef: string, amountMinor: number): Promise<{ providerRef: string }>;
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
