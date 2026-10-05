/**
 * Telegram-HTML hygiene for text that came from somewhere else.
 *
 * Product descriptions are often copied from another shop's bot or imported
 * from a supplier API, and arrive with the markup still in them as TEXT:
 * `<blockquote><tg-emoji emoji-id="…">✔️</tg-emoji> Max 2 devices…`. Escaping
 * that (the old behaviour) printed the tags literally to customers; passing it
 * through untouched would let one stray `<` or an unknown tag make Telegram
 * reject the whole message. These helpers keep exactly the subset Telegram
 * understands, with only the attributes it accepts, balance the tags, and
 * escape everything else.
 */

const ALLOWED = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "tg-spoiler", "tg-emoji", "blockquote", "span"]);
const ENTITY = /^&(?:amp|lt|gt|quot|#39|#x?[0-9a-f]+);/i;

/** Escape text for Telegram HTML, leaving already-valid entities (&amp; &lt; …) as they are. */
function escText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "<") out += "&lt;";
    else if (c === ">") out += "&gt;";
    else if (c === "&") out += ENTITY.test(s.slice(i, i + 12)) ? "&" : "&amp;";
    else out += c;
  }
  return out;
}

const attr = (raw: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(raw);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};

/** The normalised opening tag, or null when the tag/attributes are not something Telegram accepts. */
function openTag(name: string, raw: string): string | null {
  switch (name) {
    case "a": {
      const href = attr(raw, "href");
      if (!href || !/^(https?:\/\/|tg:\/\/)/i.test(href)) return null;
      return `<a href="${href.replace(/"/g, "&quot;")}">`;
    }
    case "tg-emoji": {
      const id = attr(raw, "emoji-id");
      return id && /^\d{5,25}$/.test(id) ? `<tg-emoji emoji-id="${id}">` : null;
    }
    case "span":
      return attr(raw, "class") === "tg-spoiler" ? `<span class="tg-spoiler">` : null;
    case "code": {
      const cls = attr(raw, "class");
      return cls && /^language-[\w+-]{1,30}$/.test(cls) ? `<code class="${cls}">` : "<code>";
    }
    case "blockquote":
      return /\bexpandable\b/i.test(raw) ? "<blockquote expandable>" : "<blockquote>";
    default:
      return `<${name}>`;
  }
}

/**
 * Keep only Telegram-supported markup from `html`, balanced and safe to send.
 * `<br>` becomes a newline. `dropTags` removes those tags but keeps their text
 * (a description placed inside our own <blockquote> must not open another —
 * Telegram rejects nested quotes).
 */
export function sanitizeTelegramHtml(html: string, opts: { dropTags?: string[] } = {}): string {
  const drop = new Set((opts.dropTags ?? []).map((t) => t.toLowerCase()));
  const src = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n").replace(/<\/?p[^>]*>/gi, "");
  const re = /<(\/?)([a-z][a-z0-9-]*)((?:\s[^<>]*)?)\s*\/?>/gi;
  let out = "";
  let last = 0;
  // Each stack entry: the tag name, and whether it was actually emitted.
  const stack: Array<{ name: string; kept: boolean }> = [];
  for (const m of src.matchAll(re)) {
    out += escText(src.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    if (!ALLOWED.has(name)) {
      // Unknown markup: its text survives, the tag does not.
      continue;
    }
    if (!closing) {
      // Telegram allows no tag inside <code>/<pre> except <code> in <pre>, and
      // no nested link or emoji; anything else is dropped rather than rejected.
      const inside = stack.filter((s) => s.kept).map((s) => s.name);
      const blocked = drop.has(name)
        || ((inside.includes("code") || inside.includes("pre")) && !(name === "code" && inside[inside.length - 1] === "pre"))
        || (name === "a" && inside.includes("a"))
        || (name === "tg-emoji" && inside.includes("tg-emoji"))
        || (name === "blockquote" && inside.includes("blockquote"));
      const tag = blocked ? null : openTag(name, m[3] ?? "");
      stack.push({ name, kept: tag !== null });
      if (tag) out += tag;
    } else {
      const at = stack.map((s) => s.name).lastIndexOf(name);
      if (at < 0) continue; // a closer with no opener
      // Close anything opened after it first, so the result stays nested.
      for (let k = stack.length - 1; k >= at; k--) {
        const s = stack[k]!;
        if (s.kept) out += `</${s.name}>`;
      }
      const reopen = stack.slice(at + 1);
      stack.length = at;
      // Re-open the ones that were only closed to keep nesting valid.
      for (const s of reopen) {
        if (!s.kept) { stack.push(s); continue; }
        if (s.name === "a" || s.name === "tg-emoji") continue; // these carry attributes; do not guess them back
        out += `<${s.name}>`;
        stack.push(s);
      }
    }
  }
  out += escText(src.slice(last));
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k]!.kept) out += `</${stack[k]!.name}>`;
  return out;
}

/** True when a plain-text field actually carries Telegram markup. */
export function looksLikeTelegramHtml(s: string | null | undefined): boolean {
  return !!s && /<\/?(?:b|strong|i|em|u|ins|s|strike|del|a|code|pre|span|tg-spoiler|tg-emoji|blockquote)(?:\s[^<>]*)?>/i.test(s);
}

/**
 * A product description as Telegram HTML: the operator's rich version when
 * there is one, the plain text when it carries markup (copied from another
 * bot, supplier import), otherwise the escaped plain text.
 */
export function richDescription(description: string | null | undefined, descriptionHtml: string | null | undefined, opts: { dropTags?: string[] } = {}): string {
  if (descriptionHtml) return sanitizeTelegramHtml(descriptionHtml, opts);
  if (!description) return "";
  if (looksLikeTelegramHtml(description)) return sanitizeTelegramHtml(description, opts);
  return description.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The same description as plain text (web pages, button labels, translation input). Custom emoji keep their fallback glyph. */
export function plainDescription(description: string | null | undefined, descriptionHtml?: string | null): string {
  const src = descriptionHtml ?? description ?? "";
  if (!src) return "";
  if (!descriptionHtml && !looksLikeTelegramHtml(src)) return src;
  return src
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^<>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** A Telegram message entity, as grammY delivers it. */
export interface TgEntity { type: string; offset: number; length: number; url?: string; language?: string; custom_emoji_id?: string }

/**
 * Rebuild Telegram HTML from a message's text + entities — bold, italic,
 * quotes, links, spoilers, code and premium emoji. An admin who copies a
 * description from another bot pastes it WITH its formatting; keeping only the
 * custom emoji (the old behaviour) threw the quote and bold away.
 */
export function entitiesToTelegramHtml(text: string, entities: readonly TgEntity[] | undefined): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ents = (entities ?? []).filter((e) => e.length > 0 && e.offset >= 0 && e.offset + e.length <= text.length);
  if (ents.length === 0) return esc(text);
  const open = (e: TgEntity): string | null => {
    switch (e.type) {
      case "bold": return "<b>";
      case "italic": return "<i>";
      case "underline": return "<u>";
      case "strikethrough": return "<s>";
      case "spoiler": return '<span class="tg-spoiler">';
      case "code": return "<code>";
      case "pre": return e.language && /^[\w+-]{1,30}$/.test(e.language) ? `<pre><code class="language-${e.language}">` : "<pre>";
      case "text_link": return e.url && /^(https?:\/\/|tg:\/\/)/i.test(e.url) ? `<a href="${e.url.replace(/"/g, "&quot;")}">` : null;
      case "custom_emoji": return e.custom_emoji_id ? `<tg-emoji emoji-id="${e.custom_emoji_id}">` : null;
      case "blockquote": return "<blockquote>";
      case "expandable_blockquote": return "<blockquote expandable>";
      default: return null;
    }
  };
  const close = (e: TgEntity): string => {
    switch (e.type) {
      case "bold": return "</b>";
      case "italic": return "</i>";
      case "underline": return "</u>";
      case "strikethrough": return "</s>";
      case "spoiler": return "</span>";
      case "code": return "</code>";
      case "pre": return e.language && /^[\w+-]{1,30}$/.test(e.language) ? "</code></pre>" : "</pre>";
      case "text_link": return "</a>";
      case "custom_emoji": return "</tg-emoji>";
      default: return "</blockquote>";
    }
  };
  const usable = ents.map((e, idx) => ({ e, o: open(e), idx })).filter((x): x is { e: TgEntity; o: string; idx: number } => x.o !== null);
  // Telegram nests entities properly; emit at each boundary the closers
  // (innermost first) then the openers (outermost first).
  const points = new Set<number>([0, text.length]);
  for (const { e } of usable) { points.add(e.offset); points.add(e.offset + e.length); }
  const sorted = [...points].sort((a, b) => a - b);
  let out = "";
  for (let k = 0; k < sorted.length; k++) {
    const p = sorted[k]!;
    // Ties (two entities on the same range) break by entity order: opened in
    // order, closed in exact reverse — otherwise <b><i>x</b></i>.
    const ending = usable.filter(({ e }) => e.offset + e.length === p).sort((a, b) => b.e.offset - a.e.offset || a.e.length - b.e.length || b.idx - a.idx);
    for (const { e } of ending) out += close(e);
    const starting = usable.filter(({ e }) => e.offset === p).sort((a, b) => b.e.length - a.e.length || a.idx - b.idx);
    for (const { o } of starting) out += o;
    const next = sorted[k + 1];
    if (next !== undefined) out += esc(text.slice(p, next));
  }
  return out;
}
