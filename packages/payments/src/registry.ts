import { loadConfig } from "@gis/config";
import { NowPaymentsProvider } from "./nowpayments.provider.js";
import { RazorpayProvider } from "./razorpay.provider.js";
import type { PaymentProvider, PaymentProviderId } from "./types.js";

/**
 * Config-driven provider registry (Architecture doc §4): a gateway exists only
 * when its env group is fully set. No code changes to enable/disable.
 * Product decision 2026-07-14: UPI (Razorpay) + crypto (NOWPayments) only.
 */
let registry: Map<PaymentProviderId, PaymentProvider> | undefined;

function build(): Map<PaymentProviderId, PaymentProvider> {
  if (registry) return registry;
  const config = loadConfig();
  registry = new Map();
  if (config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET && config.RAZORPAY_WEBHOOK_SECRET) {
    registry.set("razorpay", new RazorpayProvider());
  }
  if (config.NOWPAYMENTS_API_KEY && config.NOWPAYMENTS_IPN_SECRET) {
    registry.set("nowpayments", new NowPaymentsProvider());
  }
  return registry;
}

export function getProvider(id: string): PaymentProvider | null {
  return build().get(id as PaymentProviderId) ?? null;
}

export function listEnabledProviders(currency: string): PaymentProvider[] {
  return [...build().values()].filter((p) => (p.currencies as readonly string[]).includes(currency));
}

export function enabledProviderIds(): PaymentProviderId[] {
  return [...build().keys()];
}

export const PROVIDER_LABELS: Record<PaymentProviderId, string> = {
  razorpay: "🇮🇳 UPI / Cards (Razorpay)",
  nowpayments: "₿ Crypto (BTC/ETH/USDT)",
};
