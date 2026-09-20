import type { Ctx } from "./ctx.js";

/**
 * Payment conversations are "one in, one out".
 *
 * Paying by Binance or UPI is a short back-and-forth: the payment card, a
 * "paste your ID" prompt, the customer's pasted ID, maybe a "that doesn't look
 * right" retry, "verifying…", then the result. Every one of those used to stay
 * in the chat, so by the time the keys arrived they were sitting under a
 * screenful of dead instructions and stray pastes.
 *
 * This keeps ONE live message per flow. Each new step is sent first and the
 * previous steps are deleted right after, so the chat never looks empty and
 * never accumulates. The payment card (amount + Pay ID / QR) is the exception:
 * it is the thing the customer is paying against, so it survives every retry
 * and is removed only when the flow ends — the payment verified, submitted to
 * the team, cancelled or expired.
 *
 * Message ids live in the session (Redis-backed), so a flow survives a bot
 * restart. Telegram lets a bot delete its own messages, and the customer's, in
 * a private chat for 48 h; deletes are best-effort and never fail a step.
 */
const CAP = 30;

type Msg = { message_id: number } | undefined | null;

/** Track a message as part of the current flow (bot prompt or customer paste). */
export function flowRemember(ctx: Ctx, ...msgs: Msg[]): void {
  const ids = ctx.session.flowMsgIds ?? [];
  for (const m of msgs) {
    const id = m?.message_id;
    if (id && !ids.includes(id)) ids.push(id);
  }
  ctx.session.flowMsgIds = ids.slice(-CAP);
}

/** Mark the payment card of the current flow — kept until flowEnd(). */
export function flowSetCard(ctx: Ctx, card: Msg): void {
  ctx.session.flowCardId = card?.message_id;
  flowRemember(ctx, card);
}

async function deleteMany(ctx: Ctx, ids: number[]): Promise<void> {
  const chat = ctx.chat?.id;
  if (!chat || ids.length === 0) return;
  // One call for the whole batch (Bot API 7+); fall back to singles if the
  // batch is refused (e.g. one id that is too old poisons the request).
  try {
    await ctx.api.deleteMessages(chat, ids.slice(0, 100));
  } catch {
    await Promise.all(ids.map((id) => ctx.api.deleteMessage(chat, id).catch(() => undefined)));
  }
}

/**
 * Delete every tracked message except `keep` (and the card, unless
 * `dropCard`). `keep` becomes the whole flow afterwards.
 */
export async function flowSweep(ctx: Ctx, keep?: Msg, opts: { dropCard?: boolean } = {}): Promise<void> {
  const keepId = keep?.message_id;
  const cardId = opts.dropCard ? undefined : ctx.session.flowCardId;
  const ids = (ctx.session.flowMsgIds ?? []).filter((id) => id !== keepId && id !== cardId);
  const next: number[] = [];
  if (cardId) next.push(cardId);
  if (keepId && keepId !== cardId) next.push(keepId);
  ctx.session.flowMsgIds = next;
  if (opts.dropCard) ctx.session.flowCardId = undefined;
  await deleteMany(ctx, ids);
}

/** Send the next step, then remove everything before it (the card stays). */
export async function flowStep<T extends Msg>(ctx: Ctx, send: () => Promise<T>): Promise<T> {
  const next = await send();
  await flowSweep(ctx, next);
  return next;
}

/**
 * Start a fresh flow: whatever a previous, abandoned flow left behind goes,
 * and `first` (usually the payment card) is the only thing tracked.
 */
export async function flowStart(ctx: Ctx, first: Msg, opts: { card?: boolean } = { card: true }): Promise<void> {
  await flowSweep(ctx, undefined, { dropCard: true });
  if (opts.card) flowSetCard(ctx, first);
  else flowRemember(ctx, first);
}

/**
 * Finish the flow with a final message: card, prompts, pastes and progress all
 * go; the final message stays and is no longer tracked, so the next flow
 * cannot take it away.
 */
export async function flowEnd<T extends Msg>(ctx: Ctx, send: () => Promise<T>): Promise<T> {
  const last = await send();
  await flowSweep(ctx, last, { dropCard: true });
  ctx.session.flowMsgIds = [];
  return last;
}
