import { createHmac } from "node:crypto";
import { loadConfig } from "@gis/config";
import { safeEqual } from "@gis/shared";
import {
  headerValue,
  type CheckoutContext,
  type CheckoutSession,
  type NormalizedPaymentEvent,
  type PaymentProvider,
} from "./types.js";

const API_BASE = "https://api.nowpayments.io/v1";

/**
 * Crypto payments via NOWPayments hosted invoices (BTC/ETH/USDT/TRX/…).
 * - Checkout: POST /v1/invoice → hosted invoice_url the customer opens.
 * - IPN webhook: `x-nowpayments-sig` = HMAC-SHA512 of the JSON body with keys
 *   sorted recursively, keyed by the IPN secret (verified timing-safe).
 * - Crypto refunds are manual by nature — refund() rejects; the admin refunds
 *   to the customer wallet instead (PRD §6.7 wallet destination).
 */
export class NowPaymentsProvider implements PaymentProvider {
  readonly id = "nowpayments" as const;
  readonly currencies = ["INR", "USD"] as const;

  private readonly apiKey: string;
  private readonly ipnSecret: string;

  constructor() {
    const config = loadConfig();
    this.apiKey = config.NOWPAYMENTS_API_KEY!;
    this.ipnSecret = config.NOWPAYMENTS_IPN_SECRET!;
  }

  async createCheckout(ctx: CheckoutContext): Promise<CheckoutSession> {
    const config = loadConfig();
    const body = {
      price_amount: ctx.amountMinor / 100, // NOWPayments expects major units
      price_currency: ctx.currency.toLowerCase(),
      order_id: ctx.orderId,
      order_description: ctx.description.slice(0, 200),
      ...(config.PUBLIC_API_URL
        ? {
            ipn_callback_url: `${config.PUBLIC_API_URL}/webhooks/payments/nowpayments`,
            success_url: `${config.PUBLIC_API_URL}/webhooks/payments/return`,
            cancel_url: `${config.PUBLIC_API_URL}/webhooks/payments/return`,
          }
        : {}),
    };
    const res = await fetch(`${API_BASE}/invoice`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`NOWPayments invoice creation failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const invoice = (await res.json()) as { id: string | number; invoice_url: string };
    if (!invoice.invoice_url) throw new Error("NOWPayments returned an invoice without a URL");
    return { url: invoice.invoice_url, providerRef: String(invoice.id) };
  }

  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedPaymentEvent[] | null {
    const signature = headerValue(headers, "x-nowpayments-sig");
    if (!signature) return null;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }

    const expected = createHmac("sha512", this.ipnSecret)
      .update(JSON.stringify(sortKeysDeep(payload)))
      .digest("hex");
    if (!safeEqual(expected, signature)) return null;

    const status = String(payload["payment_status"] ?? "");
    const paymentId = String(payload["payment_id"] ?? "");
    const orderId = payload["order_id"] ? String(payload["order_id"]) : null;
    const priceAmount = Number(payload["price_amount"] ?? Number.NaN);
    const amountMinor = Number.isFinite(priceAmount) ? Math.round(priceAmount * 100) : null;
    const currency = payload["price_currency"] ? String(payload["price_currency"]).toUpperCase() : null;
    // No native event id → payment_id + status dedupes repeated IPNs per state.
    const base = { provider: this.id, eventId: `${paymentId}:${status}`, orderId, providerRef: paymentId, amountMinor, currency } as const;

    switch (status) {
      case "finished":
        return [{ ...base, type: "payment.succeeded" }];
      case "failed":
      case "expired":
        return [{ ...base, type: "payment.failed", failureReason: `crypto payment ${status}` }];
      case "partially_paid":
        // Underpayment: never auto-fulfill. Surfaces as a failed payment with
        // an explicit reason; admin resolves via support (top-up or wallet credit).
        return [{ ...base, type: "payment.failed", failureReason: "partially paid (underpayment)" }];
      case "refunded":
        return [{ ...base, type: "refund.processed" }];
      default:
        return []; // waiting / confirming / sending — informational only
    }
  }

  refund(): Promise<{ providerRef: string }> {
    return Promise.reject(
      new Error("Crypto refunds are manual — refund to the customer's wallet instead (PRD §6.7)"),
    );
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}
