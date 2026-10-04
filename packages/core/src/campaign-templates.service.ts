import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { sendBroadcast } from "./broadcast.service.js";
import { getComboConfig, getRenewalConfig } from "./growth.service.js";
import { getTiers } from "./loyalty.service.js";
import { getMiniAppConfig, miniAppUrl } from "./ops.service.js";
import { availableCryptoNetworks } from "./orders/crypto-checkout.service.js";
import { getPaymentRails } from "./payment-rails.service.js";
import { promoFlagsCached, getPromoFlags } from "./promos.service.js";
import { enqueueTelegramMessage, type OutboxButton } from "./queues.js";
import { getMilestoneConfig, getReferralConfig } from "./referral.service.js";
import { getSpinConfig } from "./spin.service.js";

/**
 * One-tap campaign posts for the shop's own features (not products — those
 * are promo-templates.service). Every template fills itself from the live
 * config, so "Refer & Earn" always quotes today's percentages and ladder, and
 * a template whose feature is switched off simply is not offered.
 *
 * Buttons are deep links (t.me/<bot>?start=<section>) that the bot already
 * routes, so a tap lands the customer on the right screen.
 */
export interface CampaignTemplate {
  key: string;
  label: string;
  /** Short reason it is hidden, or null when it can be sent. */
  unavailable: string | null;
  html: string;
  button: { text: string; url: string; style: "primary" | "success" | "danger" } | null;
}

const esc = (x: string): string => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export async function campaignTemplates(): Promise<CampaignTemplate[]> {
  const cfg = loadConfig();
  const store = esc(cfg.STORE_NAME);
  const botRow = cfg.BOT_USERNAME ? null : await prisma.setting.findUnique({ where: { key: "bot.username" } }).catch(() => null);
  const bot = cfg.BOT_USERNAME ?? (botRow?.value as { username?: string } | null)?.username ?? null;
  const link = (section: string): string | null => (bot ? `https://t.me/${bot}?start=${section}` : null);
  const btn = (text: string, section: string, style: "primary" | "success" | "danger" = "success") => {
    const url = link(section);
    return url ? { text, url, style } : null;
  };
  const noBot = bot ? null : "Set BOT_USERNAME (or restart the bot once) so buttons can deep-link.";

  const [flags, ref, mile, spin, combo, renewal, tiers, rails, nets, mini] = await Promise.all([
    getPromoFlags().catch(() => promoFlagsCached()),
    getReferralConfig(),
    getMilestoneConfig(),
    getSpinConfig(),
    getComboConfig(),
    getRenewalConfig(),
    getTiers().catch(() => []),
    getPaymentRails(),
    availableCryptoNetworks().catch(() => []),
    getMiniAppConfig(),
  ]);

  const out: CampaignTemplate[] = [];

  // 🎁 Refer & Earn
  {
    const what = mile.mode === "purchased" ? "friends who buy" : "friends";
    const first = mile.enabled ? mile.tiers[0] : undefined;
    const months = ref.commissionMonths;
    const forHowLong = months > 0 ? `for the next <b>${months} month${months === 1 ? "" : "s"}</b>` : "<b>for life</b>";
    const ladder = mile.enabled && mile.tiers.length > 1
      ? ["", "🏆 <b>Bonus ladder</b>", ...mile.tiers.slice(0, 4).map((t) => `• ${t.count} ${what} → <b>$${t.rewardUsd.toFixed(2)}</b>`)]
      : [];
    out.push({
      key: "refer",
      label: "🎁 Refer & Earn",
      unavailable: !flags.referral ? "Referral promotion is switched off (Marketing → Promotions)." : noBot,
      html: [
        first
          ? `🎁 <b>Refer ${first.count} ${what} → get $${first.rewardUsd.toFixed(2)} bonus!</b>`
          : `🎁 <b>Earn money by inviting friends to ${store}!</b>`,
        "",
        `<blockquote>💸 <b>${pct(ref.firstPct)}%</b> commission on every friend's first order${ref.repeatPct > 0 ? `\n🔁 <b>${pct(ref.repeatPct)}%</b> on everything they buy ${forHowLong}` : ""}${first ? `\n🏆 <b>$${first.rewardUsd.toFixed(2)}</b> bonus the moment ${first.count} ${what} are in` : ""}\n💰 Paid straight into your wallet — spend it on any product</blockquote>`,
        ...ladder,
        "",
        "1️⃣ Tap the button  2️⃣ Share your link  3️⃣ Watch your wallet grow 🚀",
      ].join("\n"),
      button: btn("🎁 Get my referral link", "refer"),
    });
  }

  // 🏆 Milestone cashback (only when configured)
  if (mile.enabled && mile.tiers.length) {
    const first = mile.tiers[0]!;
    const last = mile.tiers[mile.tiers.length - 1]!;
    out.push({
      key: "milestones",
      label: "🏆 Referral milestones",
      unavailable: noBot,
      html: [
        `🏆 <b>New: referral milestone cashback!</b>`,
        "",
        `Invite friends to ${store} and unlock <b>cash bonuses</b> on top of your referral earnings:`,
        "",
        ...mile.tiers.slice(0, 6).map((t) => `✅ <b>${t.count}</b> ${mile.mode === "purchased" ? "friends who buy" : "friends invited"} → <b>$${t.rewardUsd.toFixed(2)}</b>`),
        mile.repeatLast ? `🔁 …and <b>$${last.rewardUsd.toFixed(2)}</b> again for every further ${last.count}!` : "",
        "",
        `Only <b>${first.count}</b> ${mile.mode === "purchased" ? "buying friends" : "friends"} to your first bonus. Start now 👇`,
      ].filter((l) => l !== "").join("\n"),
      button: btn("🏆 Start inviting", "refer"),
    });
  }

  // 💰 Wallet top-up / crypto
  {
    const names = nets.slice(0, 5).map((n) => n.label.split(" · ")[1] ?? n.label);
    const methods = [
      nets.length ? `🌐 Crypto — ${esc(names.join(", "))}${nets.length > 5 ? " & more" : ""} (auto, unique address per deposit)` : "",
      rails.binanceEnabled ? "🪙 Binance Pay (USDT) — instant" : "",
      rails.upiEnabled ? "🇮🇳 UPI (INR)" : "",
    ].filter(Boolean);
    out.push({
      key: "topup",
      label: "💰 Wallet top-up",
      unavailable: methods.length === 0 ? "No payment method is switched on." : noBot,
      html: [
        `💰 <b>Top up once, buy in one tap.</b>`,
        "",
        `Keep a balance in your ${store} wallet and every order is <b>one tap</b> — no waiting for payment checks.`,
        "",
        ...methods.map((m) => `• ${m}`),
        "",
        "Deposits are credited automatically within minutes. 🔒",
      ].join("\n"),
      button: btn("💳 Top up my wallet", "topup"),
    });
  }

  // 🎀 Gift a friend
  out.push({
    key: "gift",
    label: "🎀 Gift vouchers",
    unavailable: noBot,
    html: [
      `🎀 <b>Send a gift in 10 seconds.</b>`,
      "",
      `Turn part of your wallet balance into a <b>gift code</b> and share it with anyone — they redeem it in ${store} and spend it on whatever they like.`,
      "",
      "• Any amount you choose\n• Unclaimed gifts come back to you automatically\n• Perfect for birthdays, thank-yous and giveaways 🎉",
    ].join("\n"),
    button: btn("🎀 Create a gift", "topup", "primary"),
  });

  // 🎁 Combo deal
  if (combo.enabled && combo.pct > 0) {
    out.push({
      key: "combo",
      label: "🎁 Combo deal",
      unavailable: noBot,
      html: [
        `🎁 <b>Combo deal: ${combo.pct}% off the whole cart!</b>`,
        "",
        `Add <b>${combo.minProducts} or more different products</b> to your cart and the discount applies <b>automatically</b> at checkout — no code needed.`,
        "",
        "Stack up the tools you use every day and pay less for all of them. 🛒",
      ].join("\n"),
      button: btn("🛍 Build my combo", "shop"),
    });
  }

  // 🔥 Today's deals / flash sale
  out.push({
    key: "deals",
    label: "🔥 Today's deals",
    unavailable: noBot,
    html: [
      `🔥 <b>Today's deals at ${store}</b>`,
      "",
      "<blockquote>⚡ Limited-time prices on our most popular products\n📉 Lowest prices of the week — while stock lasts\n⏰ Deals rotate daily, don't miss today's</blockquote>",
      "",
      "Tap below to see what's on sale right now 👇",
    ].join("\n"),
    button: btn("🔥 See today's deals", "deals", "danger"),
  });

  // 🎡 Spin / rewards
  if (flags.spin && spin.enabled) {
    out.push({
      key: "spin",
      label: "🎡 Spin & win",
      unavailable: noBot,
      html: [
        `🎡 <b>Spin & win cashback on every order!</b>`,
        "",
        `Every purchase at ${store} gives you a spin — win up to <b>${(spin.rewardBp / 100).toFixed(spin.rewardBp % 100 === 0 ? 0 : 1)}%</b> cashback straight into your wallet.`,
        "",
        `• Up to ${spin.maxSpinsPerDay} spin${spin.maxSpinsPerDay === 1 ? "" : "s"} a day\n• Rewards land instantly\n• Nothing to enter, nothing to claim 🍀`,
      ].join("\n"),
      button: btn("🎡 Spin now", "spin"),
    });
  }

  // 💎 VIP tiers
  if (flags.loyalty && tiers.length) {
    out.push({
      key: "tiers",
      label: "💎 VIP tiers",
      unavailable: noBot,
      html: [
        `💎 <b>Loyalty pays at ${store}.</b>`,
        "",
        "The more you shop, the better it gets:",
        "",
        ...tiers.slice(0, 5).map((t) => `• <b>${esc(t.name)}</b> — ${esc(t.perk)}`),
        "",
        "Check your tier and how close you are to the next one 👇",
      ].join("\n"),
      button: btn("💎 My VIP status", "tier", "primary"),
    });
  }

  // 🔁 Renewals
  if (renewal.enabled) {
    out.push({
      key: "renewal",
      label: "🔁 Renew & save",
      unavailable: noBot,
      html: [
        `🔁 <b>Never lose access — renew in one tap.</b>`,
        "",
        `We remind you <b>${renewal.daysBefore} day${renewal.daysBefore === 1 ? "" : "s"}</b> before anything you bought expires${renewal.pct > 0 ? `, and renewing early saves you <b>${renewal.pct}%</b>` : ""}.`,
        "",
        "Open 📦 My Orders to see what's coming up and renew early.",
      ].join("\n"),
      button: btn("📦 My orders", "orders", "primary"),
    });
  }

  // 📱 Mini App
  if (mini.enabled && miniAppUrl()) {
    out.push({
      key: "miniapp",
      label: "📱 Mini App launch",
      unavailable: noBot,
      html: [
        `📱 <b>${store} now has a Mini App!</b>`,
        "",
        "Browse the whole catalogue like a real store — <b>grid, search, categories, live stock</b> — right inside Telegram.",
        "",
        "Open the menu, tap <b>🛍 Open Shop (Mini App)</b> and enjoy. Checkout stays exactly as fast as before. ⚡",
      ].join("\n"),
      button: btn("🛍 Open the shop", "shop"),
    });
  }

  // 🛟 Support
  out.push({
    key: "support",
    label: "🛟 Support & guarantee",
    unavailable: noBot,
    html: [
      `🛟 <b>We've got your back.</b>`,
      "",
      "<blockquote>✅ Instant delivery on most products\n🔄 Replacement guarantee on warranted items\n💬 Live support right here in the bot — no email, no waiting</blockquote>",
      "",
      "Had a problem with an order? Open it in 📦 My Orders and tap <b>Report a problem</b>, or message support any time.",
    ].join("\n"),
    button: btn("💬 Talk to support", "account", "primary"),
  });

  return out;
}

/** Send one template to every customer (or to the registered groups/channels). */
export async function sendCampaign(
  key: string,
  target: "customers" | "groups",
  actorId: string,
): Promise<{ ok: boolean; targets: number; reason?: string }> {
  const t = (await campaignTemplates()).find((x) => x.key === key);
  if (!t) return { ok: false, targets: 0, reason: "Unknown template" };
  if (t.unavailable) return { ok: false, targets: 0, reason: t.unavailable };
  if (target === "customers") {
    const res = await sendBroadcast({
      title: "",
      body: t.html,
      bodyIsHtml: true,
      segment: "all",
      createdById: actorId,
      buttonText: t.button?.text,
      buttonUrl: t.button?.url,
      buttonStyle: t.button?.style ?? "success",
    });
    return { ok: true, targets: res.targets };
  }
  const groups = await prisma.postTarget.findMany({ where: { active: true } });
  if (groups.length === 0) return { ok: false, targets: 0, reason: "No group/channel registered — add the bot as admin there and send /registergroup." };
  const buttons: OutboxButton[] = t.button ? [{ text: t.button.text, url: t.button.url, style: t.button.style }] : [];
  for (const g of groups) await enqueueTelegramMessage(g.chatId, t.html, { buttons });
  return { ok: true, targets: groups.length };
}
