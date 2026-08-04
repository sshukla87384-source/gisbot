import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { sha256Hex } from "@gis/shared";
import { getRedis } from "./redis.js";


/**
 * Machine translation with a two-tier cache (Redis → Postgres), so each phrase
 * is only ever paid for once. Falls back to the original text on any failure —
 * a translation outage must never break the shop.
 *
 * Never pass secrets, keys or credentials through here.
 */

const SETTING_KEY = "translate.api";
const REDIS_TTL = 86_400; // 24h hot cache

/** Emoji, prices, URLs and bare product codes are left alone. */
function shouldSkip(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  if (!/\p{L}{2,}/u.test(t)) return true; // no real words (prices, codes, emoji-only)
  if (/^https?:\/\//i.test(t)) return true;
  return false;
}

interface Creds { provider: string; url?: string; key?: string }

async function creds(): Promise<Creds> {
  const cfg = loadConfig();
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } }).catch(() => null);
  const saved = (row?.value ?? null) as { provider?: string; url?: string; key?: string } | null;
  return {
    provider: saved?.provider ?? cfg.TRANSLATE_PROVIDER,
    url: saved?.url ?? cfg.TRANSLATE_API_URL,
    key: saved?.key ?? cfg.TRANSLATE_API_KEY,
  };
}

/** Admin: set the translation provider from the bot. */
export async function setTranslateCreds(provider: string, url: string | undefined, key: string | undefined): Promise<void> {
  const value = { provider, url: url ?? null, key: key ?? null };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value },
    update: { value },
  });
}

export async function getTranslateProvider(): Promise<string> {
  return (await creds()).provider;
}

async function callProvider(texts: string[], target: string, c: Creds): Promise<string[] | null> {
  try {
    if (c.provider === "libre") {
      const url = c.url ?? "https://libretranslate.com/translate";
      const out: string[] = [];
      for (const q of texts) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, source: "auto", target, format: "text", ...(c.key ? { api_key: c.key } : {}) }),
          signal: AbortSignal.timeout(8000), // per-request, not per-batch
        });
        if (!res.ok) return out.length === texts.length ? out : null;
        const j = (await res.json()) as { translatedText?: string };
        if (!j.translatedText) return null;
        out.push(j.translatedText);
      }
      return out;
    }
    if (c.provider === "deepl") {
      if (!c.key) return null;
      const url = c.url ?? "https://api-free.deepl.com/v2/translate";
      const body = new URLSearchParams();
      for (const t of texts) body.append("text", t);
      body.append("target_lang", target.toUpperCase());
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `DeepL-Auth-Key ${c.key}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { translations?: Array<{ text: string }> };
      return j.translations?.map((t) => t.text) ?? null;
    }
    if (c.provider === "google") {
      if (!c.key) return null;
      const url = `${c.url ?? "https://translation.googleapis.com/language/translate/v2"}?key=${encodeURIComponent(c.key)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: texts, target, format: "text" }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { data?: { translations?: Array<{ translatedText: string }> } };
      return j.data?.translations?.map((t) => t.translatedText) ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Translate several strings at once; order is preserved and originals are used on failure. */
export async function translateMany(texts: Array<string | null | undefined>, locale: string): Promise<string[]> {
  const originals = texts.map((t) => t ?? "");
  if (!locale || locale === "en") return originals;
  const c = await creds();
  if (c.provider === "none") return originals;

  const redis = getRedis();
  const out = [...originals];
  const todo: Array<{ i: number; text: string; hash: string }> = [];

  // One MGET for the whole batch instead of a round trip per string.
  const candidates: Array<{ i: number; text: string; hash: string }> = [];
  for (let i = 0; i < originals.length; i++) {
    const text = originals[i] ?? "";
    if (shouldSkip(text)) continue;
    candidates.push({ i, text, hash: sha256Hex(text) });
  }
  let hits: Array<string | null> = [];
  if (candidates.length > 0) {
    try { hits = await redis.mget(candidates.map((c) => `tr:${locale}:${c.hash}`)); } catch { hits = []; }
  }
  candidates.forEach((c, k) => {
    const hit = hits[k];
    if (hit !== null && hit !== undefined) out[c.i] = hit;
    else todo.push(c);
  });
  if (todo.length === 0) return out;

  // Postgres tier
  try {
    const rows = await prisma.translation.findMany({ where: { lang: locale, hash: { in: todo.map((t) => t.hash) } } });
    const byHash = new Map(rows.map((r) => [r.hash, r.output]));
    for (const t of [...todo]) {
      const hit = byHash.get(t.hash);
      if (hit !== undefined) {
        out[t.i] = hit;
        await redis.set(`tr:${locale}:${t.hash}`, hit, "EX", REDIS_TTL).catch(() => undefined);
        todo.splice(todo.indexOf(t), 1);
      }
    }
  } catch { /* fall through to the provider */ }
  if (todo.length === 0) return out;

  const fresh = await callProvider(todo.map((t) => t.text), locale, c);
  if (!fresh || fresh.length !== todo.length) return out; // provider failed → originals

  for (let k = 0; k < todo.length; k++) {
    const t = todo[k];
    const value = fresh[k];
    if (!t || !value) continue;
    out[t.i] = value;
    await redis.set(`tr:${locale}:${t.hash}`, value, "EX", REDIS_TTL).catch(() => undefined);
    await prisma.translation
      .upsert({
        where: { hash_lang: { hash: t.hash, lang: locale } },
        create: { hash: t.hash, lang: locale, source: t.text, output: value },
        update: { output: value },
      })
      .catch(() => undefined);
  }
  return out;
}

/** Translate a single string (cached). Returns the original on any failure. */
export async function translateText(text: string | null | undefined, locale: string): Promise<string> {
  const [out] = await translateMany([text], locale);
  return out ?? (text ?? "");
}
