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
): Promise<{ key: string; expiresAt: Date | null }> {
  const statuses = preferReserved ? ["RESERVED", "AVAILABLE"] : ["AVAILABLE"];
  for (const status of statuses) {
    const rows = await tx.$queryRaw<Array<{ id: string; keyEncrypted: string; expiresAt: Date | null }>>`
      SELECT "id", "keyEncrypted", "expiresAt" FROM "LicenseKey"
      WHERE "variantId" = ${variantId} AND "status" = ${status}::"InventoryStatus" AND "deletedAt" IS NULL
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
): Promise<{ username: string; password: string; expiresAt: Date | null }> {
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
export function buildDeliveryText(
  productName: string,
  variantName: string,
  payload: DeliveryPayload,
  activationGuide?: string | null,
): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const vn = variantName.trim().toLowerCase() === "standard" ? "" : ` · ${esc(variantName)}`;
  const lines = ["🎉🎊 <b>Congratulations — your order is delivered!</b> 🥳", "", `📦 <b>${esc(productName)}</b>${vn}`, ""];
  if (payload.key) lines.push(`🔑 <code>${esc(payload.key)}</code>`);
  if (payload.username) lines.push(`👤 Login: <code>${esc(payload.username)}</code>`);
  if (payload.password) lines.push(`🔒 Password: <tg-spoiler>${esc(payload.password)}</tg-spoiler>`);
  if (payload.username) lines.push("", "⚠️ Please do not change the account password.");
  if (payload.expiresAt) lines.push(`⏳ Valid until: ${payload.expiresAt.slice(0, 10)}`);
  if (activationGuide) lines.push("", `📄 ${esc(activationGuide)}`);
  lines.push("", "💾 Saved in 🔑 My Licenses · Enjoy! 🚀", "Problem? Open a 🎫 Support ticket.");
  return lines.join("\n");
}
