import { prisma } from "@gis/database";
import { formatMinor, type CurrencyCode } from "@gis/shared";
import { adjustWallet } from "./wallet/wallet.service.js";
import { enqueueAdminAlert, enqueueTelegramMessage } from "./queues.js";
import { getRedis } from "./redis.js";
import { autoVerifyUpiTopup, dropUpiTopupClaim, readUpiTopupClaim, upiUtrKey, type UpiTopupClaim } from "./upi-utr.service.js";

/**
 * Credit a UPI wallet top-up WITHOUT an admin, once its payment is proven from
 * the merchant account (autoVerifyUpiTopup). The UTR is the ledger's
 * idempotency key (@unique), so an admin tapping ✅ Approve on the same claim
 * afterwards — or this running twice — can never credit it a second time.
 */
export async function settleUpiTopup(
  claimId: string,
  claim: UpiTopupClaim,
): Promise<{ ok: true; creditMinor: number; currency: string; balance: bigint } | { ok: false; reason: string }> {
  const v = await autoVerifyUpiTopup(claim);
  if (!v.ok) return { ok: false, reason: v.reason };
  const wal = await prisma.wallet.findUnique({ where: { userId: claim.userId }, select: { currency: true } });
  const currency = (wal?.currency ?? "USD") as string;
  const creditMinor = currency === "INR" ? claim.inrMinor : claim.usdMinor;
  let balance: bigint;
  try {
    balance = await adjustWallet({
      userId: claim.userId,
      amountMinor: BigInt(creditMinor),
      type: "DEPOSIT",
      note: `UPI top-up ₹${(claim.inrMinor / 100).toFixed(2)} · UTR ${claim.utr} (auto-verified)`,
      idempotencyKey: upiUtrKey(claim.utr),
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") { await dropUpiTopupClaim(claimId); return { ok: false, reason: "ALREADY_CREDITED" }; }
    throw e;
  }
  await dropUpiTopupClaim(claimId);
  const u = await prisma.user.findUnique({ where: { id: claim.userId }, select: { telegramId: true, telegramHandle: true, firstName: true } });
  if (u?.telegramId != null) {
    await enqueueTelegramMessage(
      u.telegramId,
      [
        "✅ <b>Wallet topped up!</b>",
        "",
        `💵 UPI payment: <b>₹${(claim.inrMinor / 100).toFixed(2)}</b> · UTR <code>${claim.utr}</code>`,
        `💰 Credited: <b>${formatMinor(creditMinor, currency as CurrencyCode)}</b>`,
        `💳 New balance: <b>${formatMinor(Number(balance), currency as CurrencyCode)}</b>`,
        "",
        "<i>Verified automatically — no waiting.</i>",
      ].join("\n"),
      { buttons: [{ text: "🛍 Shop now", callbackData: "shp:home:1", style: "success" }] },
    ).catch(() => undefined);
  }
  const who = u?.telegramHandle ? `@${u.telegramHandle}` : (u?.firstName ?? "customer");
  await enqueueAdminAlert(
    `🤖 <b>UPI top-up auto-verified</b>\n👤 ${who.replace(/&/g, "&amp;").replace(/</g, "&lt;")} · ₹${(claim.inrMinor / 100).toFixed(2)} → ${formatMinor(creditMinor, currency as CurrencyCode)}\n🧾 UTR <code>${claim.utr}</code> matched in BharatPe. (The earlier approve card for it does nothing now.)`,
  ).catch(() => undefined);
  return { ok: true, creditMinor, currency, balance };
}

/**
 * Top-ups whose UTR was pasted before BharatPe showed the payment: retried
 * after every UPI poll, for up to a day. Claims live in Redis (upitopup:*).
 */
export async function settlePendingUpiTopups(limit = 50): Promise<number> {
  let settled = 0;
  try {
    const redis = getRedis();
    let cursor = "0";
    const ids: string[] = [];
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "upitopup:*", "COUNT", 200);
      cursor = next;
      for (const k of keys) ids.push(k.slice("upitopup:".length));
    } while (cursor !== "0" && ids.length < limit);
    for (const id of ids.slice(0, limit)) {
      const claim = await readUpiTopupClaim(id);
      if (!claim || (claim.at && Date.now() - claim.at > 24 * 3600_000)) continue;
      const r = await settleUpiTopup(id, claim).catch(() => ({ ok: false as const, reason: "ERROR" }));
      if (r.ok) settled++;
    }
  } catch { /* next poll tries again */ }
  return settled;
}
