/**
 * ┌─────────────────────────────────────────────────────────────┐
 * │  CENTRAL CUSTOM-EMOJI CONFIG — the ONLY place to put IDs.    │
 * └─────────────────────────────────────────────────────────────┘
 * Paste your Telegram custom_emoji_id values below (get them by forwarding
 * the emoji to @userinfobot). Leave "" to keep the Unicode fallback.
 *
 * The bot only sends custom emoji that it is allowed to send (from a pack your
 * bot owns); otherwise it gracefully falls back to Unicode — nothing breaks.
 *
 * These values are merged with the CUSTOM_EMOJI_JSON env var (env wins), so you
 * can set IDs here in code OR via environment — never hardcoded anywhere else.
 */
export const CUSTOM_EMOJI_IDS: Record<string, string> = {
  wallet: "",
  cart: "",
  success: "",
  error: "",
  vip: "",
  coin: "",
  sparkle: "",
  loading: "",
  fire: "",
  gift: "",
  box: "",
  rocket: "",
  star: "",
  diamond: "",
  chart: "",
  home: "",
  support: "",
  lang: "",
  money: "",
  shop: "",
  profile: "",
  referral: "",
  bolt: "",
  clock: "",
};
