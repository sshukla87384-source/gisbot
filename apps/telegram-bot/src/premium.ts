/**
 * Centralized premium UI helpers (visual only — no business logic).
 * Fancy numbers, bold Unicode, headers, cards, progress bars, VIP animation.
 */
import type { Context } from "grammy";

const BOLD_DIGIT_BASE = 0x1d7ec; // 𝟬
const BOLD_UPPER_BASE = 0x1d5d4; // 𝗔
const BOLD_LOWER_BASE = 0x1d5ee; // 𝗮

/** Convert digits in a value to premium bold digits: 1234 → 𝟭𝟮𝟯𝟰 */
export function num(value: string | number | bigint): string {
  return String(value).replace(/[0-9]/g, (d) => String.fromCodePoint(BOLD_DIGIT_BASE + Number(d)));
}

/** Bold sans-serif Unicode for A–Z, a–z and digits: "Wallet" → "𝗪𝗮𝗹𝗹𝗲𝘁" */
export function bold(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 65 && c <= 90) out += String.fromCodePoint(BOLD_UPPER_BASE + (c - 65));
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(BOLD_LOWER_BASE + (c - 97));
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(BOLD_DIGIT_BASE + (c - 48));
    else out += ch;
  }
  return out;
}

export const HR = "━━━━━━━━━━━━━━━━━━━━";

/** Premium header block: separators + bold title. */
export function header(title: string): string {
  return `${HR}\n${title}\n${HR}`;
}

/** Unicode progress bar: progressBar(60) → 🟩🟩🟩🟩🟩🟩⬜⬜⬜⬜ */
export function progressBar(pct: number, len = 10): string {
  const filled = Math.max(0, Math.min(len, Math.round((pct / 100) * len)));
  return "🟩".repeat(filled) + "⬜".repeat(len - filled);
}

/** Premium success card. */
export function successCard(title: string, lines: string[]): string {
  return [HR, `🎉 ${bold(title)}`, HR, ...lines, HR].join("\n");
}

/** Premium error card. */
export function errorCard(reason: string): string {
  return [HR, `❌ ${bold("Error")}`, HR, "", reason, HR].join("\n");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * VIP purchase animation — edits ONE message through frames (~900ms each).
 * Cosmetic only; the caller performs the real checkout separately.
 */
export async function vipAnimation(ctx: Context): Promise<void> {
  const bar = (f: number) => "🟩".repeat(f) + "□".repeat(10 - f);
  const frames = [
    `${bar(1)}\n⏳ ${bold("Initializing Purchase")}…`,
    `${bar(3)}\n📈 ${bold("Checking Stock")}…`,
    `${bar(5)}\n💳 ${bold("Processing Payment")}…`,
    `${bar(7)}\n📦 ${bold("Preparing Account")}…`,
    `${bar(9)}\n🚀 ${bold("Delivering Product")}…`,
    `${bar(10)}\n🎉 ${bold("Order Completed Successfully")}`,
  ];
  let msgId: number | undefined;
  try {
    const sent = await ctx.reply(frames[0]!, { parse_mode: "HTML" });
    msgId = sent.message_id;
    for (let i = 1; i < frames.length; i++) {
      await sleep(900);
      if (ctx.chat) await ctx.api.editMessageText(ctx.chat.id, msgId, frames[i]!, { parse_mode: "HTML" }).catch(() => undefined);
    }
    await sleep(700);
  } catch {
    /* animation is best-effort */
  }
}
