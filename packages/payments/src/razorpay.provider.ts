import { createHmac } from "node:crypto";
import { loadConfig } from "@gis/config";
import { safeEqual, sha256Hex } from "@gis/shared";
import Razorpay from "razorpay";
import {
  headerValue,
  type CheckoutContext,
  type CheckoutSession,
  type NormalizedPaymentEvent,
  type PaymentProvider,
} from "./types.js";

/**
 * Razorpay via Payment Links (hosted page: UPI, cards, netbanking, wallets).
 * Webhook signature: HMAC-SHA256 of the raw body with the webhook secret,
 * compared timing-safe against `x-razorpay-signature` (Security doc §5).
 */
export class RazorpayProvider implements PaymentProvider {
  readonly id = "razorpay" as const;
  readonly currencies = ["INR"] as const;

  private readonly client: Razorpay;
  private readonly webhookSecret: string;

  constructor() {
    const config = loadConfig();
    this.client = new Razorpay({
      key_id: config.RAZORPAY_KEY_ID!,
      key_secret: config.RAZORPAY_KEY_SECRET!,
    });
    this.webhookSecret = config.RAZORPAY_WEBHOOK_SECRET!;
  }

  async createCheckout(ctx: CheckoutContext): Promise<CheckoutSession> {
    const config = loadConfig();
    // The SDK's paymentLink typings model an "advanced options" overload that
    // rejects the documented plain body — call through a narrow local type.
    const createLink = this.client.paymentLink.create.bind(this.client.paymentLink) as unknown as (
      body: Record<string, unknown>,
    ) => Promise<{ id: string; short_url: string }>;
    const link = await createLink({
      amount: ctx.amountMinor,
      currency: ctx.currency,
      description: ctx.description.slice(0, 250),
      notes: { orderId: ctx.orderId, orderNumber: ctx.orderNumber },
      ...(ctx.customerEmail ? { customer: { email: ctx.customerEmail } } : {}),
      ...(config.PUBLIC_API_URL
        ? { callback_url: `${config.PUBLIC_API_URL}/webhooks/payments/return`, callback_method: "get" }
        : {}),
    });
    return { url: link.short_url, providerRef: link.id };
  }

  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedPaymentEvent[] | null {
    const signature = headerValue(headers, "x-razorpay-signature");
    if (!signature) return null;
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    if (!safeEqual(expected, signature)) return null;

    interface RzpEvent {
      event: string;
      payload?: {
        payment_link?: { entity?: { id?: string; notes?: Record<string, string> } };
        payment?: {
          entity?: {
            id?: string;
            amount?: number;
            currency?: string;
            notes?: Record<string, string>;
            error_description?: string;
          };
        };
        refund?: { entity?: { id?: string; payment_id?: string; amount?: number; currency?: string } };
      };
    }
    let event: RzpEvent;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as RzpEvent;
    } catch {
      return null;
    }

    // Razorpay sends x-razorpay-event-id; fall back to a body hash so replayed
    // bodies still dedupe via the (provider, eventId) unique constraint.
    const eventId = headerValue(headers, "x-razorpay-event-id") ?? sha256Hex(rawBody.toString("utf8"));
    const payment = event.payload?.payment?.entity;
    const notes = event.payload?.payment_link?.entity?.notes ?? payment?.notes ?? {};

    switch (event.event) {
      case "payment_link.paid":
        return [
          {
            provider: this.id,
            eventId,
            type: "payment.succeeded",
            orderId: notes["orderId"] ?? null,
            providerRef: payment?.id ?? event.payload?.payment_link?.entity?.id ?? null,
            amountMinor: payment?.amount ?? null,
            currency: payment?.currency ?? null,
          },
        ];
      case "payment.failed":
        return [
          {
            provider: this.id,
            eventId,
            type: "payment.failed",
            orderId: notes["orderId"] ?? null,
            providerRef: payment?.id ?? null,
            amountMinor: payment?.amount ?? null,
            currency: payment?.currency ?? null,
            failureReason: payment?.error_description,
          },
        ];
      case "refund.processed": {
        const refund = event.payload?.refund?.entity;
        return [
          {
            provider: this.id,
            eventId,
            type: "refund.processed",
            orderId: null,
            providerRef: refund?.payment_id ?? null,
            amountMinor: refund?.amount ?? null,
            currency: refund?.currency ?? null,
          },
        ];
      }
      default:
        return []; // valid signature, event type we don't act on
    }
  }

  async refund(providerRef: string, amountMinor: number): Promise<{ providerRef: string }> {
    const refund = await this.client.payments.refund(providerRef, { amount: amountMinor });
    return { providerRef: refund.id ?? providerRef };
  }
}
