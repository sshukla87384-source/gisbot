import { loadConfig } from "@gis/config";
import { enqueueTelegramDocument, enqueueTelegramMessage, DELIVERY_BUTTONS, type OutboxButton } from "../queues.js";
import {
  buildCombinedDeliveryText,
  buildDeliveryTxt,
  buildDeliveryText,
  combinedDeliveryButtons,
  copyButtonsFor,
  DELIVERY_FILE_THRESHOLD,
  greetName,
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
  const card: string[] = [n.headline];
  if (product) card.push(`📦 <b>${esc(product)}</b>`);
  card.push(`🧾 Order <code>${esc(n.orderNumber)}</code> — ${n.money}`);
  if (n.deliveries.length > 0) card.push("👆 <b>Your items are in the message above</b> — always saved in 📦 My Orders.");
  if (n.pendingManual > 0) card.push(`⏳ <b>${n.pendingManual} item(s) being prepared</b> — they arrive here automatically, usually within a minute.`);
  if (n.awaitingStock > 0) card.push(`⚠️ ${n.awaitingStock} item(s) went out of stock at the last moment — our team will restock or refund you shortly.`);
  if (n.deliveries.length > 0) {
    card.push("", `🙏 Thank you so much, ${greetName({ telegramHandle: n.buyerHandle ?? null, firstName: n.buyerFirst ?? null })} — enjoy your purchase from ${esc(cfg.STORE_NAME)}! 💙`);
  }
  const extras: string[] = [];
  if (n.deliveries.length > 0) {
    const instr = await deliveryInstructionsMessage().catch(() => null);
    if (instr) extras.push(instr);
    // First delivery of the day only — see shouldSendReferralNudge.
    if (await shouldSendReferralNudge(n.userId)) {
      const nudge = referralNudgeMessage(n.buyerReferral, cfg.BOT_USERNAME);
      if (nudge) extras.push(nudge);
    }
  }
  const buttons: OutboxButton[] = [
    ...(n.deliveries.length > 0 ? [{ text: "⚡ Buy again", callbackData: `ord:again:${n.orderId}`, style: "success" as const }] : []),
    ...DELIVERY_BUTTONS,
  ];
  let closing = [card.join("\n"), ...extras].join("\n\n");
  let overflow: string | null = null;
  if (closing.length > MAX_TEXT) {
    // Over-long shop instructions: they get their own message rather than
    // sinking the closing card (a rejected follow-up is silently lost).
    closing = card.join("\n");
    overflow = extras.join("\n\n");
  }
  const followUp = { text: closing, buttons, clutter: true };

  if (n.deliveries.length === 0) {
    // Nothing to hand over yet (all manual / out of stock): the card IS the message.
    await enqueueTelegramMessage(n.telegramId, closing, { buttons, clutter: true });
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
      `🎉 Your order is delivered! ${n.deliveries.length} items are in the attached file. 💾 Saved in 🔑 My Licenses.`,
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
  if (overflow) await enqueueTelegramMessage(n.telegramId, overflow, { clutter: true, delayMs: 1500 });
}
