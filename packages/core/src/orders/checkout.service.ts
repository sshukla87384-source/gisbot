import { loadConfig } from "@gis/config";
import { nextOrderNumber, prisma, type Currency, type Prisma } from "@gis/database";
import { CoreError, decryptSecret, encryptSecret } from "@gis/shared";

/**
 * Wallet-funded checkout with automatic fulfillment (PRD §6.1, Security doc §5).
 *
 * Everything runs in ONE database transaction:
 *   wallet row lock → live price recheck → order + items → inventory assignment
 *   via FOR UPDATE SKIP LOCKED → ledger debit → audit log.
 * Duplicate delivery is impossible: LicenseKey.orderItemId is UNIQUE.
 * Gateway checkouts (Razorpay/Stripe/…) reuse assignInventory() in Phase 10 —
 * only the funding step differs.
 */

export interface DeliveredSecret {
  orderItemId: string;
  productName: string;
  variantName: string;
  kind: "LICENSE_KEY" | "DIGITAL_ACCOUNT";
  /** Plaintext, for immediate dispatch only. Never persist or log. */
  secret: { key?: string; username?: string; password?: string; expiresAt?: string };
  activationGuide: string | null;
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  totalMinor: number;
  currency: Currency;
  status: "COMPLETED" | "PENDING_FULFILLMENT";
  deliveries: DeliveredSecret[];
  pendingManualItems: number;
}

type Tx = Prisma.TransactionClient;

interface PricedLine {
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

async function priceCart(tx: Tx, userId: string, currency: Currency): Promise<PricedLine[]> {
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

  return cart.items.map((item) => {
    const v = item.variant;
    if (!v.isActive || v.deletedAt !== null || v.product.status !== "ACTIVE" || v.product.deletedAt !== null) {
      throw new CoreError("CART_ITEM_UNAVAILABLE", `${v.product.name} is no longer available`);
    }
    const price = v.prices[0];
    if (!price) throw new CoreError("PRICE_UNAVAILABLE", `${v.product.name} has no ${currency} price`);
    return {
      variantId: v.id,
      productId: v.productId,
      productName: v.product.name,
      variantName: v.name,
      productType: v.product.type,
      activationGuide: v.product.activationGuide,
      resellerId: v.product.resellerId,
      quantity: item.quantity,
      unitPriceMinor: price.amountMinor,
      fulfillmentMode: (v.fulfillmentMode ?? v.product.fulfillmentMode) as "AUTOMATIC" | "MANUAL",
    };
  });
}

async function assignLicenseKey(
  tx: Tx,
  variantId: string,
  orderItemId: string,
  masterKey: string,
): Promise<{ key: string; expiresAt: Date | null }> {
  const rows = await tx.$queryRaw<Array<{ id: string; keyEncrypted: string; expiresAt: Date | null }>>`
    SELECT "id", "keyEncrypted", "expiresAt" FROM "LicenseKey"
    WHERE "variantId" = ${variantId} AND "status" = 'AVAILABLE' AND "deletedAt" IS NULL
    ORDER BY "createdAt" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED`;
  const row = rows[0];
  if (!row) throw new CoreError("OUT_OF_STOCK");

  await tx.licenseKey.update({
    where: { id: row.id },
    data: { status: "SOLD", soldAt: new Date(), orderItemId },
  });
  return { key: decryptSecret(row.keyEncrypted, masterKey), expiresAt: row.expiresAt };
}

async function assignAccountSlot(
  tx: Tx,
  variantId: string,
  orderItemId: string,
  masterKey: string,
): Promise<{ username: string; password: string; expiresAt: Date | null }> {
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
    WHERE "variantId" = ${variantId} AND "status" = 'AVAILABLE' AND "deletedAt" IS NULL
      AND "usedSlots" < "maxSlots"
    ORDER BY "createdAt" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED`;
  const row = rows[0];
  if (!row) throw new CoreError("OUT_OF_STOCK");

  const nowFull = row.usedSlots + 1 >= row.maxSlots;
  await tx.digitalAccount.update({
    where: { id: row.id },
    data: { usedSlots: { increment: 1 }, ...(nowFull ? { status: "SOLD" } : {}) },
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

export async function checkoutWithWallet(userId: string): Promise<CheckoutResult> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;

  return prisma.$transaction(
    async (tx) => {
      // 1) Lock wallet (serializes concurrent checkouts per user).
      const wallets = await tx.$queryRaw<Array<{ id: string; balanceMinor: bigint; currency: Currency }>>`
        SELECT "id", "balanceMinor", "currency" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
      const wallet = wallets[0];
      if (!wallet) throw new CoreError("WALLET_NOT_FOUND");

      // 2) Re-price cart from live rows in the wallet currency.
      const lines = await priceCart(tx, userId, wallet.currency);
      const totalMinor = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
      if (wallet.balanceMinor < BigInt(totalMinor)) throw new CoreError("INSUFFICIENT_BALANCE");

      // 3) Create order.
      const orderNumber = await nextOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId,
          status: "PAID",
          currency: wallet.currency,
          subtotalMinor: totalMinor,
          walletUsedMinor: totalMinor,
          totalMinor: 0, // nothing owed via gateway
          paidAt: new Date(),
        },
      });

      // 4) Items — inventory-backed quantities expand to unit items so the
      //    1:1 unique inventory↔item constraint can do its job.
      const deliveries: DeliveredSecret[] = [];
      let pendingManualItems = 0;

      for (const line of lines) {
        const isUnitStocked = line.productType === "LICENSE_KEY" || line.productType === "DIGITAL_ACCOUNT";
        const unitCount = isUnitStocked ? line.quantity : 1;

        for (let i = 0; i < unitCount; i++) {
          const item = await tx.orderItem.create({
            data: {
              orderId: order.id,
              variantId: line.variantId,
              productNameSnap: line.productName,
              variantNameSnap: line.variantName,
              resellerIdSnap: line.resellerId,
              quantity: isUnitStocked ? 1 : line.quantity,
              unitPriceMinor: line.unitPriceMinor,
              totalMinor: isUnitStocked ? line.unitPriceMinor : line.unitPriceMinor * line.quantity,
              fulfillmentMode: line.fulfillmentMode,
            },
          });

          if (line.fulfillmentMode === "MANUAL") {
            pendingManualItems++;
            continue;
          }

          if (line.productType === "LICENSE_KEY") {
            const { key, expiresAt } = await assignLicenseKey(tx, line.variantId, item.id, masterKey);
            const payload = { kind: "LICENSE_KEY", key, expiresAt: expiresAt?.toISOString() };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            deliveries.push({
              orderItemId: item.id,
              productName: line.productName,
              variantName: line.variantName,
              kind: "LICENSE_KEY",
              secret: { key, expiresAt: expiresAt?.toISOString() },
              activationGuide: line.activationGuide,
            });
          } else if (line.productType === "DIGITAL_ACCOUNT") {
            const creds = await assignAccountSlot(tx, line.variantId, item.id, masterKey);
            const payload = { kind: "DIGITAL_ACCOUNT", ...creds, expiresAt: creds.expiresAt?.toISOString() };
            await tx.orderItem.update({
              where: { id: item.id },
              data: {
                fulfilledAt: new Date(),
                deliveryPayloadEncrypted: encryptSecret(JSON.stringify(payload), masterKey),
              },
            });
            deliveries.push({
              orderItemId: item.id,
              productName: line.productName,
              variantName: line.variantName,
              kind: "DIGITAL_ACCOUNT",
              secret: {
                username: creds.username,
                password: creds.password,
                expiresAt: creds.expiresAt?.toISOString(),
              },
              activationGuide: line.activationGuide,
            });
          } else {
            // DOWNLOAD / SUBSCRIPTION / MANUAL_SERVICE automatic flows arrive
            // with their delivery mechanisms in later phases; route to manual
            // fulfillment rather than failing the paid order.
            pendingManualItems++;
            await tx.orderItem.update({ where: { id: item.id }, data: { fulfillmentMode: "MANUAL" } });
          }
        }
      }

      // 5) Wallet debit (append-only ledger + cached balance).
      const newBalance = wallet.balanceMinor - BigInt(totalMinor);
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: "PURCHASE",
          amountMinor: -BigInt(totalMinor),
          balanceAfterMinor: newBalance,
          currency: wallet.currency,
          orderId: order.id,
          referenceNote: orderNumber,
          idempotencyKey: `purchase:${order.id}`,
        },
      });
      await tx.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: newBalance } });

      // 6) Invoice row (PDF rendering lands with the notifications phase).
      await tx.invoice.create({
        data: { orderId: order.id, invoiceNumber: orderNumber.replace(/^GIS/, "INV") },
      });

      // 7) Finalize order status, first-purchase marker, cart cleanup, audit.
      const finalStatus = pendingManualItems > 0 ? "PENDING_FULFILLMENT" : "COMPLETED";
      await tx.order.update({
        where: { id: order.id },
        data: { status: finalStatus, ...(finalStatus === "COMPLETED" ? { completedAt: new Date() } : {}) },
      });
      await tx.user.updateMany({
        where: { id: userId, firstPurchaseAt: null },
        data: { firstPurchaseAt: new Date() },
      });
      const cart = await tx.cart.findUnique({ where: { userId } });
      if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          actorType: "USER",
          action: "order.checkout.wallet",
          entityType: "Order",
          entityId: order.id,
          after: { orderNumber, totalMinor, currency: wallet.currency, items: lines.length },
        },
      });

      return {
        orderId: order.id,
        orderNumber,
        totalMinor,
        currency: wallet.currency,
        status: finalStatus,
        deliveries,
        pendingManualItems,
      };
    },
    { timeout: 15_000 },
  );
}
