import type { Currency, Prisma } from "@gis/database";
import { CoreError, decryptSecret } from "@gis/shared";
import { effectivePriceMinor } from "../pricing.js";

/**
 * Shared inventory-assignment primitives used by BOTH the wallet checkout and
 * webhook fulfillment (Security doc §5). All selects use FOR UPDATE SKIP LOCKED
 * inside the caller's transaction; the UNIQUE orderItemId constraints make
 * duplicate delivery impossible at the database level.
 */

export type Tx = Prisma.TransactionClient;

export interface PricedLine {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  productType: string;
  activationGuide: string | null;
  resellerId: string | null;
  quantity: number;
  unitPriceMinor: number;
  fulfillmentMode: "AUTOMATIC" | "MANUAL";
  allowPwChange: boolean;
}

/** Re-price the user's cart from live price rows (RETAIL tier). */
export async function priceCart(tx: Tx, userId: string, currency: Currency, channel: "DIRECT" | "API" = "DIRECT"): Promise<PricedLine[]> {
  const cart = await tx.cart.findUnique({
    where: { userId },
    include: {
      items: {
        include: {
          variant: {
            include: {
              product: true,
              prices: { where: { currency, tier: { name: "RETAIL" } } },
            },
          },
        },
      },
    },
  });
  if (!cart || cart.items.length === 0) throw new CoreError("CART_EMPTY");

  // VIP per-user price overrides (by product) for this user, for this channel.
  // A channel-specific price (DIRECT/API) wins over a BOTH price.
  const overrides = await tx.userPrice.findMany({ where: { userId, channel: { in: [channel, "BOTH"] } } });
  const overrideByProduct = new Map<string, number>();
  for (const o of overrides) {
    const cur = overrideByProduct.get(o.productId);
    if (cur === undefined || o.channel === channel) overrideByProduct.set(o.productId, o.amountMinor);
  }

  return cart.items.map((item) => {
    const v = item.variant;
    if (!v.isActive || v.deletedAt !== null || v.product.status !== "ACTIVE" || v.product.deletedAt !== null) {
      throw new CoreError("CART_ITEM_UNAVAILABLE", `${v.product.name} is no longer available`);
    }
    const price = v.prices[0];
    if (!price) throw new CoreError("PRICE_UNAVAILABLE", `${v.product.name} has no ${currency} price`);
    const vipOverride = overrideByProduct.get(v.productId);
    return {
      variantId: v.id,
      productId: v.productId,
      productName: v.product.name,
      variantName: v.name,
      productType: v.product.type,
      activationGuide: v.product.activationGuide,
      allowPwChange: v.product.allowPasswordChange,
      resellerId: v.product.resellerId,
      quantity: item.quantity,
      unitPriceMinor: vipOverride ?? effectivePriceMinor(price.amountMinor, v.product),
      fulfillmentMode: (v.fulfillmentMode ?? v.product.fulfillmentMode) as "AUTOMATIC" | "MANUAL",
    };
  });
}

/**
 * Assign one license key to an order item. When `preferReserved` is set
 * (gateway fulfillment), RESERVED rows are consumed before AVAILABLE ones.
 */
export async function assignLicenseKey(
  tx: Tx,
  variantId: string,
  orderItemId: string,
  masterKey: string,
  preferReserved = false,
  excludeIds: string[] = [],
): Promise<{ key: string; expiresAt: Date | null }> {
  const exclude = excludeIds.length > 0 ? excludeIds : ["-"];
  const statuses = preferReserved ? ["RESERVED", "AVAILABLE"] : ["AVAILABLE"];
  for (const status of statuses) {
    const rows = await tx.$queryRaw<Array<{ id: string; keyEncrypted: string; expiresAt: Date | null }>>`
      SELECT "id", "keyEncrypted", "expiresAt" FROM "LicenseKey"
      WHERE "variantId" = ${variantId} AND "status" = ${status}::"InventoryStatus" AND "deletedAt" IS NULL
        AND NOT ("id" = ANY(${exclude}::text[]))
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    const row = rows[0];
    if (!row) continue;
    await tx.licenseKey.update({
      where: { id: row.id },
      data: { status: "SOLD", soldAt: new Date(), orderItemId, reservedUntil: null },
    });
    return { key: decryptSecret(row.keyEncrypted, masterKey), expiresAt: row.expiresAt };
  }
  throw new CoreError("OUT_OF_STOCK");
}

/** Assign one digital-account slot (shared accounts: maxSlots/usedSlots). */
export async function assignAccountSlot(
  tx: Tx,
  variantId: string,
  orderItemId: string,
  masterKey: string,
  preferReserved = false,
  excludeIds: string[] = [],
): Promise<{ username: string; password: string; expiresAt: Date | null }> {
  const exclude = excludeIds.length > 0 ? excludeIds : ["-"];
  const statuses = preferReserved ? ["RESERVED", "AVAILABLE"] : ["AVAILABLE"];
  for (const status of statuses) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        usernameEncrypted: string;
        passwordEncrypted: string;
        expiresAt: Date | null;
        maxSlots: number;
        usedSlots: number;
      }>
    >`
      SELECT "id", "usernameEncrypted", "passwordEncrypted", "expiresAt", "maxSlots", "usedSlots"
      FROM "DigitalAccount"
      WHERE "variantId" = ${variantId} AND "status" = ${status}::"InventoryStatus" AND "deletedAt" IS NULL
        AND "usedSlots" < "maxSlots"
        AND NOT ("id" = ANY(${exclude}::text[]))
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    const row = rows[0];
    if (!row) continue;
    const nowFull = row.usedSlots + 1 >= row.maxSlots;
    await tx.digitalAccount.update({
      where: { id: row.id },
      data: {
        usedSlots: { increment: 1 },
        reservedUntil: null,
        ...(nowFull ? { status: "SOLD" as const } : { status: "AVAILABLE" as const }),
      },
    });
    await tx.accountAssignment.create({
      data: { accountId: row.id, orderItemId, slotLabel: `Slot ${row.usedSlots + 1}` },
    });
    return {
      username: decryptSecret(row.usernameEncrypted, masterKey),
      password: decryptSecret(row.passwordEncrypted, masterKey),
      expiresAt: row.expiresAt,
    };
  }
  throw new CoreError("OUT_OF_STOCK");
}

export interface DeliveryPayload {
  kind: string;
  key?: string;
  username?: string;
  password?: string;
  expiresAt?: string;
}

/** HTML delivery message — same shape the bot renders (Bot UX doc §6). */
/**
 * Split one delivered line into an id/password pair when it looks like one
 * ("user | pass", "user:pass"). License keys are left untouched — note that
 * "-" is never treated as a separator because keys look like XXXX-XXXX-XXXX.
 */
export function splitCredential(line: string): { id: string; pw: string } | null {
  const t = line.trim();
  if (!t) return null;
  const bar = t.indexOf("|");
  if (bar > 0) {
    const id = t.slice(0, bar).trim();
    const pw = t.slice(bar + 1).trim();
    if (id && pw) return { id, pw };
    return null;
  }
  // exactly one colon, and neither side contains spaces → user:pass
  const parts = t.split(":");
  if (parts.length === 2) {
    const id = (parts[0] ?? "").trim();
    const pw = (parts[1] ?? "").trim();
    if (id && pw && !/\s/.test(id) && !/\s/.test(pw)) return { id, pw };
  }
  return null;
}

export function buildDeliveryText(
  productName: string,
  variantName: string,
  payload: DeliveryPayload,
  activationGuide?: string | null,
  allowPwChange?: boolean,
): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const vn = variantName.trim().toLowerCase() === "standard" ? "" : ` · ${esc(variantName)}`;
  const lines = ["🎉🎊 <b>Congratulations — your order is delivered!</b> 🥳", "", `📦 <b>${esc(productName)}</b>${vn}`, ""];

  let renderedCreds = false;
  if (payload.key) {
    // One delivered blob may hold several lines (multi-quantity or an account list).
    const rows = payload.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    const creds = rows.map(splitCredential);
    const allCreds = rows.length > 0 && creds.every((c) => c !== null);
    if (allCreds) {
      renderedCreds = true;
      rows.forEach((_, i) => {
        const c = creds[i] as { id: string; pw: string };
        if (rows.length > 1) lines.push(`<b>${i + 1}.</b>`);
        lines.push(`🆔 <b>ID / Login:</b> <code>${esc(c.id)}</code>`);
        lines.push(`🔑 <b>Password:</b> <code>${esc(c.pw)}</code>`);
        if (rows.length > 1 && i < rows.length - 1) lines.push("");
      });
    } else if (rows.length > 1) {
      lines.push("🔑 <b>Your keys:</b>");
      for (const r of rows) lines.push(`<code>${esc(r)}</code>`);
    } else {
      lines.push(`🔑 <b>Key:</b> <code>${esc(payload.key)}</code>`);
    }
  }
  if (payload.username) lines.push(`🆔 <b>ID / Login:</b> <code>${esc(payload.username)}</code>`);
  if (payload.password) lines.push(`🔑 <b>Password:</b> <code>${esc(payload.password)}</code>`);
  if (payload.username || renderedCreds) {
    lines.push("", "ℹ️ Tap the ID or Password to copy it.");
    lines.push(allowPwChange ? "🔓 This account is yours — you're welcome to change the password." : "🔒 Please do <b>not</b> change the account password.");
  }
  if (payload.expiresAt) lines.push(`⏳ Valid until: ${payload.expiresAt.slice(0, 10)}`);
  if (activationGuide) lines.push("", `📄 ${esc(activationGuide)}`);
  lines.push("", "💾 Saved in 🔑 My Licenses · Enjoy! 🚀", "Problem? Open a 🎫 Support ticket.");
  return lines.join("\n");
}

/** Friendly display name for greetings: @handle, else first name, else "there". */
export function greetName(u: { telegramHandle?: string | null; firstName?: string | null }): string {
  const f = (u.firstName ?? "").trim();
  if (f) return f.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (u.telegramHandle) return `@${u.telegramHandle}`;
  return "there";
}

/** Warm, respectful, personalised thank-you sent after a successful purchase. */
export function thankYouMessage(u: { telegramHandle?: string | null; firstName?: string | null }, storeName: string): string {
  return [
    `🎁 <b>Thank you so much, ${greetName(u)}!</b> 🙏`,
    `It's truly an honour to serve you. We deeply appreciate your trust in ${storeName}.`,
    `Wishing you the very best — enjoy your purchase! 💙`,
  ].join("\n");
}

/** Orders with more than this many delivered items get a .txt file instead of one long chat message. */
export const DELIVERY_FILE_THRESHOLD = 15;

export interface DeliveryLine {
  productName: string;
  variantName: string;
  payload: DeliveryPayload;
  activationGuide?: string | null;
  allowPwChange?: boolean;
}

/** One consolidated HTML message for a whole multi-item order (used when count ≤ threshold). */
export function buildCombinedDeliveryText(items: DeliveryLine[], orderNumber?: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out: string[] = [`🎉🎊 <b>Your order is delivered!</b> 🥳  (${items.length} item${items.length === 1 ? "" : "s"})`];
  if (orderNumber) out.push(`🧾 Order <b>${esc(orderNumber)}</b>`);
  out.push("");
  items.forEach((it, i) => {
    const vn = it.variantName.trim().toLowerCase() === "standard" ? "" : ` · ${esc(it.variantName)}`;
    out.push(`<b>${i + 1}.</b> 📦 <b>${esc(it.productName)}</b>${vn}`);
    const p = it.payload;
    if (p.key) {
      const rows = p.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
      const creds = rows.map(splitCredential);
      if (rows.length > 0 && creds.every((c) => c !== null)) {
        rows.forEach((_, k) => {
          const c = creds[k] as { id: string; pw: string };
          if (rows.length > 1) out.push(`   <b>${k + 1})</b>`);
          out.push(`   🆔 ID: <code>${esc(c.id)}</code>`);
          out.push(`   🔑 Password: <code>${esc(c.pw)}</code>`);
        });
        out.push(`   ${it.allowPwChange ? "🔓 Password can be changed" : "🔒 Do not change the password"}`);
      } else if (rows.length > 1) {
        for (const r of rows) out.push(`   🔑 <code>${esc(r)}</code>`);
      } else {
        out.push(`   🔑 Key: <code>${esc(p.key)}</code>`);
      }
    }
    if (p.username) out.push(`   🆔 ID: <code>${esc(p.username)}</code>`);
    if (p.password) out.push(`   🔑 Password: <code>${esc(p.password)}</code>`);
    if (p.password) out.push(`   ${it.allowPwChange ? "🔓 Password can be changed" : "🔒 Do not change the password"}`);
    if (p.expiresAt) out.push(`   ⏳ ${p.expiresAt.slice(0, 10)}`);
    out.push("");
  });
  out.push("💾 Saved in 🔑 My Licenses · Enjoy! 🚀", "Problem? Open a 🎫 Support ticket.");
  return out.join("\n");
}

/** Plaintext body for the .txt attachment sent for large orders (> threshold). */
export function buildDeliveryTxt(items: DeliveryLine[], orderNumber?: string): string {
  const out: string[] = [];
  out.push(`ORDER DELIVERY${orderNumber ? ` — ${orderNumber}` : ""}`);
  out.push(`${items.length} item(s)`);
  out.push("=".repeat(40), "");
  items.forEach((it, i) => {
    const vn = it.variantName.trim().toLowerCase() === "standard" ? "" : ` · ${it.variantName}`;
    out.push(`${i + 1}) ${it.productName}${vn}`);
    const p = it.payload;
    if (p.key) {
      const rows = p.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
      const creds = rows.map(splitCredential);
      if (rows.length > 0 && creds.every((c) => c !== null)) {
        rows.forEach((_, k) => {
          const c = creds[k] as { id: string; pw: string };
          out.push(`   ${rows.length > 1 ? `${k + 1}) ` : ""}ID: ${c.id}`);
          out.push(`   ${rows.length > 1 ? "   " : ""}Password: ${c.pw}`);
        });
      } else {
        for (const r of rows) out.push(`   Key: ${r}`);
      }
    }
    if (p.username) out.push(`   Login: ${p.username}`);
    if (p.password) out.push(`   Password: ${p.password}`);
    if (p.expiresAt) out.push(`   Valid until: ${p.expiresAt.slice(0, 10)}`);
    if (it.activationGuide) out.push(`   Note: ${it.activationGuide}`);
    out.push("");
  });
  out.push("Saved in My Licenses. Problem? Open a Support ticket in the bot.");
  return out.join("\n");
}
