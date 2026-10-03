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
export interface NowPaymentsCreds {
  apiKey: string;
  ipnSecret: string;
}

/** A unique deposit address issued for ONE payment (POST /v1/payment). */
export interface DirectCryptoPayment {
  paymentId: string;
  payAddress: string;
  /** Exact amount to send, as the API quoted it (decimal string, asset units). */
  payAmount: string;
  /** NOWPayments pay-currency code, e.g. "usdttrc20". */
  payCurrency: string;
  /** Destination tag / memo some chains need (TON, XRP, …) — must be shown. */
  payinExtraId: string | null;
  /** Fiat the invoice was priced in and the amount, for the receipt. */
  priceAmount: number;
  priceCurrency: string;
  expiresAt: Date | null;
  network: string | null;
}

export interface DirectCryptoStatus {
  paymentId: string;
  /** waiting | confirming | confirmed | sending | partially_paid | finished | failed | refunded | expired */
  status: string;
  payAddress: string | null;
  payAmount: string;
  actuallyPaid: string;
  payCurrency: string;
  priceAmount: number;
  priceCurrency: string;
  orderId: string | null;
  updatedAt: Date | null;
}

export class NowPaymentsProvider implements PaymentProvider {
  readonly id = "nowpayments" as const;
  readonly currencies = ["INR", "USD"] as const;

  private readonly apiKey: string;
  private readonly ipnSecret: string;

  /**
   * Credentials come from the environment by default; the admin panel can
   * hand in a pair it keeps encrypted in the database instead.
   */
  constructor(creds?: NowPaymentsCreds) {
    const config = loadConfig();
    this.apiKey = creds?.apiKey ?? config.NOWPAYMENTS_API_KEY!;
    this.ipnSecret = creds?.ipnSecret ?? config.NOWPAYMENTS_IPN_SECRET!;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; error?: string; code?: string };
        detail = String(j.message ?? j.error ?? j.code ?? detail);
      } catch { /* plain text */ }
      throw new Error(`NOWPayments ${res.status}: ${detail}`);
    }
    return (await res.json()) as T;
  }

  /** GET /v1/status — "OK" when the API key reaches the service. */
  async ping(): Promise<string> {
    const r = await this.api<{ message?: string }>("/status");
    return String(r.message ?? "OK");
  }

  /** Pay-currency codes this merchant account can accept right now. */
  async listPayCurrencies(): Promise<string[]> {
    // /v1/merchant/coins = the coins enabled in the merchant's dashboard; the
    // generic /v1/currencies lists everything NOWPayments supports.
    try {
      const r = await this.api<{ selectedCurrencies?: string[] }>("/merchant/coins");
      if (Array.isArray(r.selectedCurrencies) && r.selectedCurrencies.length > 0) {
        return r.selectedCurrencies.map((c) => String(c).toLowerCase());
      }
    } catch { /* fall through to the full list */ }
    const all = await this.api<{ currencies?: string[] }>("/currencies");
    return (all.currencies ?? []).map((c) => String(c).toLowerCase());
  }

  /** Smallest payment the network/coin accepts, in pay-currency units. */
  async minAmount(payCurrency: string, priceCurrency: string): Promise<{ minAmount: number; fiatEquivalent: number | null }> {
    const q = new URLSearchParams({ currency_from: payCurrency.toLowerCase(), currency_to: priceCurrency.toLowerCase(), fiat_equivalent: "usd" });
    const r = await this.api<{ min_amount?: number | string; fiat_equivalent?: number | string }>(`/min-amount?${q}`);
    const fiat = Number(r.fiat_equivalent);
    return { minAmount: Number(r.min_amount ?? 0), fiatEquivalent: Number.isFinite(fiat) ? fiat : null };
  }

  /** How much of `payCurrency` a fiat amount is right now (no payment created). */
  async estimate(priceAmount: number, priceCurrency: string, payCurrency: string): Promise<number> {
    const q = new URLSearchParams({ amount: String(priceAmount), currency_from: priceCurrency.toLowerCase(), currency_to: payCurrency.toLowerCase() });
    const r = await this.api<{ estimated_amount?: number | string }>(`/estimate?${q}`);
    return Number(r.estimated_amount ?? 0);
  }

  /**
   * Issue a fresh deposit address for one payment. Every call returns a new
   * address, so two customers can never collide on the same wallet and an
   * amount needs no "unique tail" to be matched.
   */
  async createPayment(input: {
    orderId: string;
    priceAmount: number;
    priceCurrency: "USD" | "INR";
    payCurrency: string;
    description: string;
    /** Called back with every status change; falls back to polling when unset. */
    ipnCallbackUrl?: string;
  }): Promise<DirectCryptoPayment> {
    const body: Record<string, unknown> = {
      price_amount: input.priceAmount,
      price_currency: input.priceCurrency.toLowerCase(),
      pay_currency: input.payCurrency.toLowerCase(),
      order_id: input.orderId,
      order_description: input.description.slice(0, 200),
      // The customer covers the network/service fee, so the merchant receives
      // the full price and a payment is not "partially paid" by the fee alone.
      is_fee_paid_by_user: true,
      ...(input.ipnCallbackUrl ? { ipn_callback_url: input.ipnCallbackUrl } : {}),
    };
    const r = await this.api<{
      payment_id: string | number;
      pay_address: string;
      pay_amount: number | string;
      pay_currency: string;
      payin_extra_id?: string | null;
      price_amount?: number | string;
      price_currency?: string;
      expiration_estimate_date?: string;
      network?: string | null;
    }>("/payment", { method: "POST", body: JSON.stringify(body) });
    if (!r.payment_id || !r.pay_address) throw new Error("NOWPayments returned a payment without an address");
    const exp = r.expiration_estimate_date ? new Date(r.expiration_estimate_date) : null;
    return {
      paymentId: String(r.payment_id),
      payAddress: String(r.pay_address),
      payAmount: trimAmount(r.pay_amount),
      payCurrency: String(r.pay_currency ?? input.payCurrency).toLowerCase(),
      payinExtraId: r.payin_extra_id ? String(r.payin_extra_id) : null,
      priceAmount: Number(r.price_amount ?? input.priceAmount),
      priceCurrency: String(r.price_currency ?? input.priceCurrency).toUpperCase(),
      expiresAt: exp && !Number.isNaN(exp.getTime()) ? exp : null,
      network: r.network ? String(r.network) : null,
    };
  }

  /** GET /v1/payment/{id} — the polling counterpart of the IPN. */
  async getPayment(paymentId: string): Promise<DirectCryptoStatus> {
    const r = await this.api<{
      payment_id: string | number;
      payment_status: string;
      pay_address?: string;
      pay_amount?: number | string;
      actually_paid?: number | string;
      pay_currency?: string;
      price_amount?: number | string;
      price_currency?: string;
      order_id?: string | null;
      updated_at?: string | number;
    }>(`/payment/${encodeURIComponent(paymentId)}`);
    const upd = r.updated_at ? new Date(r.updated_at) : null;
    return {
      paymentId: String(r.payment_id ?? paymentId),
      status: String(r.payment_status ?? ""),
      payAddress: r.pay_address ? String(r.pay_address) : null,
      payAmount: trimAmount(r.pay_amount),
      actuallyPaid: trimAmount(r.actually_paid),
      payCurrency: String(r.pay_currency ?? "").toLowerCase(),
      priceAmount: Number(r.price_amount ?? 0),
      priceCurrency: String(r.price_currency ?? "").toUpperCase(),
      orderId: r.order_id ? String(r.order_id) : null,
      updatedAt: upd && !Number.isNaN(upd.getTime()) ? upd : null,
    };
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
    // Without a payment_id the eventId below degrades to ":finished", which is
    // the SAME key for every such IPN: the unique (provider,eventId) row makes
    // the first one win and every later payment is discarded as a duplicate —
    // a paid order that is never fulfilled. An IPN with no payment id is not
    // something we can identify, so it is rejected outright (null = invalid).
    const rawPaymentId = payload["payment_id"];
    const paymentId = rawPaymentId === undefined || rawPaymentId === null ? "" : String(rawPaymentId).trim();
    if (!paymentId) return null;
    const orderId = payload["order_id"] ? String(payload["order_id"]) : null;
    const priceAmount = Number(payload["price_amount"] ?? Number.NaN);
    const amountMinor = Number.isFinite(priceAmount) ? Math.round(priceAmount * 100) : null;
    const currency = payload["price_currency"] ? String(payload["price_currency"]).toUpperCase() : null;
    const crypto = {
      payCurrency: String(payload["pay_currency"] ?? "").toLowerCase(),
      payAmount: trimAmount(payload["pay_amount"] as number | string | undefined),
      actuallyPaid: trimAmount(payload["actually_paid"] as number | string | undefined),
      ...(payload["pay_address"] ? { payAddress: String(payload["pay_address"]) } : {}),
    };
    // No native event id → payment_id + status dedupes repeated IPNs per state.
    // A partial payment can grow (the customer tops the address up), so each
    // distinct amount is its own event; a repeat of the same amount is not.
    const eventId = status === "partially_paid" ? `${paymentId}:${status}:${crypto.actuallyPaid}` : `${paymentId}:${status}`;
    const base = { provider: this.id, eventId, orderId, providerRef: paymentId, amountMinor, currency, crypto } as const;

    switch (status) {
      case "finished":
        return [{ ...base, type: "payment.succeeded" }];
      case "failed":
      case "expired":
        return [{ ...base, type: "payment.failed", failureReason: `crypto payment ${status}` }];
      case "partially_paid":
        // Underpayment: never auto-fulfil an order on it. The customer can send
        // the remainder to the SAME address and the payment then finishes, so
        // this is a nudge, not a failure — and a wallet top-up credits what
        // actually arrived.
        return [{ ...base, type: "payment.partial", failureReason: `partially paid: ${crypto.actuallyPaid} of ${crypto.payAmount} ${crypto.payCurrency.toUpperCase()}` }];
      case "refunded":
        return [{ ...base, type: "refund.processed" }];
      default:
        return []; // waiting / confirming / sending — informational only
    }
  }

  /** Turn a polled status into the same normalized events an IPN would carry. */
  statusToEvents(st: DirectCryptoStatus): NormalizedPaymentEvent[] {
    const crypto = { payCurrency: st.payCurrency, payAmount: st.payAmount, actuallyPaid: st.actuallyPaid, ...(st.payAddress ? { payAddress: st.payAddress } : {}) };
    const eventId = st.status === "partially_paid" ? `${st.paymentId}:${st.status}:${st.actuallyPaid}` : `${st.paymentId}:${st.status}`;
    const base = {
      provider: this.id, eventId, orderId: st.orderId, providerRef: st.paymentId,
      amountMinor: Number.isFinite(st.priceAmount) ? Math.round(st.priceAmount * 100) : null,
      currency: st.priceCurrency || null, crypto,
    } as const;
    switch (st.status) {
      case "finished": return [{ ...base, type: "payment.succeeded" }];
      case "failed":
      case "expired": return [{ ...base, type: "payment.failed", failureReason: `crypto payment ${st.status}` }];
      case "partially_paid": return [{ ...base, type: "payment.partial", failureReason: `partially paid: ${st.actuallyPaid} of ${st.payAmount} ${st.payCurrency.toUpperCase()}` }];
      case "refunded": return [{ ...base, type: "refund.processed" }];
      default: return [];
    }
  }

  refund(): Promise<{ providerRef: string }> {
    return Promise.reject(
      new Error("Crypto refunds are manual — refund to the customer's wallet instead (PRD §6.7)"),
    );
  }
}

/** "10.000000" → "10", "0.50" → "0.5", keeps up to 8 decimals; never exponent form. */
function trimAmount(v: number | string | undefined | null): string {
  if (v === undefined || v === null || v === "") return "0";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  const fixed = n.toFixed(8);
  return fixed.replace(/\.?0+$/, "") || "0";
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
