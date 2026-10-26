import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { enqueueTelegramDocument, enqueueTelegramMessage, DELIVERY_BUTTONS, type OutboxButton } from "../queues.js";
import {
  buildCombinedDeliveryText,
  buildDeliveryTxt,
  buildDeliveryText,
  combinedDeliveryButtons,
  copyButtonsFor,
  DELIVERY_FILE_THRESHOLD,
  deliveryNotesText,
  type DeliveryLine,
} from "./assign.js";
import { referralNudgeMessage, shouldSendReferralNudge } from "../users/user.service.js";
import { deliveryInstructionsMessage } from "../admin.service.js";
import { groupOrderLines } from "./order.service.js";

export interface DeliveredOrderNotice {
  telegramId: bigint | string;
  userId: string;
  orderId: string;
  orderNumber: string;
  /** Pre-formatted amount the customer paid for this order, e.g. "$4.99". */
  money: string;
  deliveries: Array<DeliveryLine & { orderItemId?: string }>;
  pendingManual: number;
  awaitingStock: number;
  buyerHandle?: string | null;
  buyerFirst?: string | null;
  buyerReferral?: string | null;
  /** First line of the closing card, e.g. "🎉 Payment received!". */
  headline: string;
}

/** Telegram's cap is 4096; keep headroom for the premium-emoji rewrite. */
const MAX_TEXT = 3900;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Everything a customer gets when a paid order is delivered — as ONE outbox
 * job: the keys, then (in the same job, so always AFTER them) one closing card.
 *
 * It used to be up to eight separate jobs: "Payment received — delivering
 * now", the keys, "✅ Delivered", thank-you, referral pitch, instructions,
 * "being prepared", "out of stock". The outbox runs five jobs at once, so
 * they also landed in random order — the referral pitch above the keys, the
 * "delivering now" after them — and none of them ever went away.
 *
 * The closing card is marked as chat clutter: the next delivery removes it,
 * so a regular customer's chat holds their keys, not a pile of old banners.
 */
export async function sendDeliveredOrderMessages(n: DeliveredOrderNotice): Promise<void> {
  const cfg = loadConfig();
  const first = n.deliveries[0];
  // Units of the same product are separate deliveries — count products, not units.
  const groups = groupOrderLines(n.deliveries.map((d) => ({ productNameSnap: d.productName, variantNameSnap: d.variantName, quantity: 1 })));
  const g0 = groups[0];
  const product = g0
    ? `${g0.productNameSnap}${g0.quantity > 1 ? ` ×${g0.quantity}` : ""}${groups.length > 1 ? ` +${groups.length - 1} more` : ""}`
    : "";
  const buttons: OutboxButton[] = [
    ...(n.deliveries.length > 0 ? [{ text: "⚡ Buy again", callbackData: `ord:again:${n.orderId}`, style: "success" as const }] : []),
    ...DELIVERY_BUTTONS,
  ];
  // After the keys: ONLY the shop's delivery instructions, as their own short
  // message (or a one-line "delivered" when there are none). No tier, spin,
  // thank-you card or referral pitch bundled in — customers can see all of
  // that in their account, and the bundle made every delivery a wall of text.
  // Remembered as clutter, so only the latest one stays in the chat.
  const instr = n.deliveries.length > 0 ? await deliveryInstructionsMessage().catch(() => null) : null;
  const closing = instr && instr.length <= MAX_TEXT ? instr : "✅ <b>Delivered</b> — always saved in 📦 My Orders.";
  const followUp = { text: closing, buttons, clutter: true };
  // Rare, but the customer must know: items still coming / out of stock.
  const notes: string[] = [];
  if (n.pendingManual > 0) notes.push(`⏳ <b>${n.pendingManual} item(s) being prepared</b> — they arrive here automatically.`);
  if (n.awaitingStock > 0) notes.push(`⚠️ ${n.awaitingStock} item(s) went out of stock at the last moment — our team will restock or refund you shortly.`);
  if (n.deliveries.length === 0) {
    // Nothing to hand over yet (all manual / out of stock): one short message.
    await enqueueTelegramMessage(
      n.telegramId,
      [`${n.headline}`, `🧾 Order <code>${esc(n.orderNumber)}</code>${product ? ` · ${esc(product)}` : ""} — ${n.money}`, ...notes].join("\n"),
      { buttons, clutter: true },
    );
    return;
  } else if (n.deliveries.length === 1) {
    const d = first!;
    await enqueueTelegramMessage(
      n.telegramId,
      buildDeliveryText(d.productName, d.variantName, d.payload, d.activationGuide, d.allowPwChange, { amountLabel: n.money, orderNumber: n.orderNumber }),
      { buttons: copyButtonsFor(d.payload, { ...(d.orderItemId ? { orderItemId: d.orderItemId } : {}), orderId: n.orderId }), followUp },
    );
  } else if (n.deliveries.length > DELIVERY_FILE_THRESHOLD) {
    await enqueueTelegramDocument(
      n.telegramId,
      `order-${n.orderNumber}.txt`,
      buildDeliveryTxt(n.deliveries, n.orderNumber, { amountLabel: n.money }),
      // The list is in the file; the product's note / instructions go HERE,
      // once, instead of being repeated on every line of the file.
      [
        `🎉 <b>${esc(product || "Your order")}</b> — ${n.deliveries.length} items in the attached file.`,
        deliveryNotesText(n.deliveries),
        "💾 Saved in 📦 My Orders.",
      ].filter(Boolean).join("\n\n"),
      [{ text: "📋 Copy ALL", callbackData: `dl:copyall:${n.orderId}` }],
      followUp,
    );
  } else {
    await enqueueTelegramMessage(
      n.telegramId,
      buildCombinedDeliveryText(n.deliveries, n.orderNumber, { amountLabel: n.money }),
      { buttons: combinedDeliveryButtons(n.deliveries, n.orderId), followUp },
    );
  }
  if (notes.length > 0) await enqueueTelegramMessage(n.telegramId, notes.join("\n"), { clutter: true, delayMs: 1500 });
  // Referral pitch: NEW customers only (their first paid order), once. A
  // regular buyer already knows about it and got it again on every order.
  if (await isFirstPaidOrder(n.userId) && await shouldSendReferralNudge(n.userId)) {
    const nudge = referralNudgeMessage(n.buyerReferral, cfg.BOT_USERNAME);
    if (nudge) await enqueueTelegramMessage(n.telegramId, nudge, { clutter: true, delayMs: 3000 });
  }
}

/** True when this customer has exactly one paid order — the one just delivered. */
export async function isFirstPaidOrder(userId: string): Promise<boolean> {
  try {
    const n = await prisma.order.count({
      where: { userId, status: { in: ["PAID", "COMPLETED", "PENDING_FULFILLMENT", "AWAITING_STOCK", "PARTIALLY_REFUNDED"] } },
    });
    return n <= 1;
  } catch {
    return false;
  }
}
