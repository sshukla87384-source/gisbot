import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";

/**
 * Which manual rails the shop offers right now — switched from the bot's admin
 * panel, no redeploy. The .env still decides whether a rail is CONFIGURED
 * (UPI_ID, BINANCE_PAY_UID); this decides whether it is OFFERED.
 *
 * `upiMaxMinor` caps UPI by order value (INR minor units): UPI is checked by
 * hand and chargebacks on big tickets hurt, so an operator can keep UPI for
 * small orders and push the large ones to crypto / Binance, which verify
 * themselves. null = no cap.
 */
export interface PaymentRails {
  upiEnabled: boolean;
  binanceEnabled: boolean;
  upiMaxMinor: number | null;
}

const KEY = "payments.rails";
const DEFAULTS: PaymentRails = { upiEnabled: true, binanceEnabled: true, upiMaxMinor: null };

let cache: { at: number; value: PaymentRails } | null = null;

export async function getPaymentRails(): Promise<PaymentRails> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  let value = DEFAULTS;
  try {
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    const v = row?.value as Partial<PaymentRails> | null | undefined;
    if (v && typeof v === "object") {
      value = {
        upiEnabled: v.upiEnabled !== false,
        binanceEnabled: v.binanceEnabled !== false,
        upiMaxMinor: typeof v.upiMaxMinor === "number" && v.upiMaxMinor > 0 ? Math.round(v.upiMaxMinor) : null,
      };
    }
  } catch { /* defaults */ }
  cache = { at: Date.now(), value };
  return value;
}

export async function setPaymentRails(patch: Partial<PaymentRails>): Promise<PaymentRails> {
  const cur = await getPaymentRails();
  const next: PaymentRails = { ...cur, ...patch };
  if (next.upiMaxMinor !== null && !(next.upiMaxMinor > 0)) next.upiMaxMinor = null;
  // A fresh literal: Prisma's Json input wants an index-signature object, which
  // an interface-typed value is not.
  const value = { upiEnabled: next.upiEnabled, binanceEnabled: next.binanceEnabled, upiMaxMinor: next.upiMaxMinor };
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  cache = { at: Date.now(), value: next };
  return next;
}

/** Binance Pay is configured AND switched on. */
export async function binanceOffered(): Promise<boolean> {
  if (!loadConfig().BINANCE_PAY_UID) return false;
  return (await getPaymentRails()).binanceEnabled;
}

/**
 * UPI is configured, switched on, and — when an order value is given — the
 * order is within the UPI cap. `amountMinor` is in INR minor units.
 */
export async function upiOffered(amountMinor?: number): Promise<{ ok: boolean; reason?: "off" | "over_limit"; maxMinor?: number }> {
  if (!loadConfig().UPI_ID) return { ok: false, reason: "off" };
  const rails = await getPaymentRails();
  if (!rails.upiEnabled) return { ok: false, reason: "off" };
  if (rails.upiMaxMinor !== null && amountMinor !== undefined && amountMinor > rails.upiMaxMinor) {
    return { ok: false, reason: "over_limit", maxMinor: rails.upiMaxMinor };
  }
  return { ok: true };
}
