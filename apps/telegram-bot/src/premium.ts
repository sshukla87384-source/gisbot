/**
 * Centralized premium UI helpers (visual only — no business logic).
 * Fancy numbers, bold Unicode, headers, cards, progress bars, VIP animation.
 */
import type { Context } from "grammy";
import { e } from "./emoji.js";
export { e } from "./emoji.js";

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
  return [HR, `${e("sparkle")} ${bold(title)}`, HR, ...lines, HR].join("\n");
}

/** Premium error card. */
export function errorCard(reason: string): string {
  return [HR, `${e("error")} ${bold("Error")}`, HR, "", reason, HR].join("\n");
}


/**
 * The purchase animation, run ALONGSIDE the real work instead of before it.
 *
 * The old version played six 900 ms frames and only then started the checkout,
 * so every wallet purchase waited ~6 s for a cartoon. Now the first frame goes
 * out at once, frames tick while the order is processed (≈ every 0.6 s — fast
 * enough to feel alive, slow enough for Telegram's edit limits), and the
 * moment the work finishes the final frame shows and the message is removed.
 * The work's result or error passes straight through.
 */
export async function withPurchaseAnimation<T>(ctx: Context, work: () => Promise<T>): Promise<T> {
  const steps = [
    ["🔐", "Securing payment"],
    ["📦", "Reserving your item"],
    ["⚡", "Preparing delivery"],
    ["🚀", "Almost there"],
  ] as const;
  const spinner = ["◐", "◓", "◑", "◒"];
  const frame = (i: number, pct: number): string => {
    const [icon, label] = steps[Math.min(steps.length - 1, Math.floor(i / 2))]!;
    const filled = Math.round(pct / 10);
    return `${spinner[i % spinner.length]} ${bold("Processing your order")}\n${"▰".repeat(filled)}${"▱".repeat(10 - filled)} <b>${num(pct)}%</b>\n${icon} ${label}…`;
  };
  let msgId: number | undefined;
  let done = false;
  let tick = 0;
  let pct = 12;
  try {
    const sent = await ctx.reply(frame(0, pct), { parse_mode: "HTML" });
    msgId = sent.message_id;
  } catch { /* animation is best-effort */ }
  // Interruptible wait: the moment the work finishes the loop stops — it used
  // to sit out its 600 ms sleep (plus a 450 ms "confirmed" frame) before the
  // keys could be sent, a second-plus of dead time on every wallet purchase.
  let wake: (() => void) | undefined;
  const nap = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  const loop = (async () => {
    while (!done && msgId && ctx.chat) {
      // 1.2 s per frame: Telegram throttles edits per chat, and a flood-wait
      // earned by the spinner would delay the delivery message right after it.
      await nap(1200);
      if (done) break;
      tick++;
      // Ease towards 90 % — it never claims "done" before the work is.
      pct = Math.min(90, pct + Math.max(3, Math.round((90 - pct) / 3)));
      await ctx.api.editMessageText(ctx.chat.id, msgId, frame(tick, pct), { parse_mode: "HTML" }).catch(() => undefined);
    }
  })();
  const stop = async (): Promise<void> => {
    done = true;
    wake?.();
    await loop;
    // Gone, not left behind: a stale "Processing…" card above the keys reads
    // as a stuck order. Deleted in the background so delivery is not held up.
    if (msgId && ctx.chat) void ctx.api.deleteMessage(ctx.chat.id, msgId).catch(() => undefined);
  };
  try {
    const result = await work();
    await stop();
    return result;
  } catch (e) {
    await stop();
    throw e;
  }
}

/** @deprecated kept for callers outside the purchase path. */
export async function vipAnimation(ctx: Context): Promise<void> {
  await withPurchaseAnimation(ctx, async () => undefined);
}
