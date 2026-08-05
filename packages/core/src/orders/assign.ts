import type { Currency, Prisma } from "@gis/database";
import { loadConfig } from "@gis/config";
import { convertMinor } from "../fx.js";
import { CoreError, decryptSecret } from "@gis/shared";
import { effectivePriceMinor } from "../pricing.js";

/**
 * Shared inventory-assignment primitives used by BOTH the wallet checkout and
 * webhook fulfillment (Security doc §5). All selects use FOR UPDATE SKIP LOCKED
 * inside the caller's transaction; the UNIQUE orderItemId constraints make
 * duplicate delivery impossible at the database level.
 */

export type Tx = Prisma.TransactionClient;

export interface PricedLine {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  productType: string;
  activationGuide: string | null;
  resellerId: string | null;
  quantity: number;
  unitPriceMinor: number;
  fulfillmentMode: "AUTOMATIC" | "MANUAL";
  allowPwChange: boolean;
  /** When set, EVERY buyer gets this same value. */
  reusableSecret: string | null;
  /** Remaining sellable quantity for a reusable product; null = unlimited. */
  reusableStock: number | null;
}

/** Re-price the user's cart from live price rows (RETAIL tier). */
export async function priceCart(tx: Tx, userId: string, currency: Currency, channel: "DIRECT" | "API" = "DIRECT"): Promise<PricedLine[]> {
  const masterKey = loadConfig().ENCRYPTION_MASTER_KEY;
  const cart = await tx.cart.findUnique({
    where: { userId },
    include: {
      items: {
        include: {
          variant: {
            include: {
              product: true,
              // All RETAIL prices: prefer the requested currency, else convert.
              prices: { where: { tier: { name: "RETAIL" } } },
            },
          },
        },
      },
    },
  });
  if (!cart || cart.items.length === 0) throw new CoreError("CART_EMPTY");

  // VIP per-user price overrides (by product) for this user, for this channel.
  // A channel-specific price (DIRECT/API) wins over a BOTH price.
  const overrides = await tx.userPrice.findMany({ where: { userId, channel: { in: [channel, "BOTH"] } } });
  const overrideByProduct = new Map<string, number>();
  for (const o of overrides) {
    // Overrides carry their own currency — convert before charging.
    const amount = o.currency === currency ? o.amountMinor : convertMinor(o.amountMinor, o.currency as Currency, currency);
    const cur = overrideByProduct.get(o.productId);
    if (cur === undefined || o.channel === channel) overrideByProduct.set(o.productId, amount);
  }

  return cart.items.map((item) => {
    const v = item.variant;
    if (!v.isActive || v.deletedAt !== null || v.product.status !== "ACTIVE" || v.product.deletedAt !== null) {
      throw new CoreError("CART_ITEM_UNAVAILABLE", `${v.product.name} is no longer available`);
    }
    const exact = v.prices.find((p) => p.currency === currency);
    const other = v.prices[0];
    if (!exact && !other) throw new CoreError("PRICE_UNAVAILABLE", `${v.product.name} has no price`);
    // No price list in this currency → convert the one we have at the configured rate.
    const price = exact ?? { amountMinor: convertMinor((other as NonNullable<typeof other>).amountMinor, (other as NonNullable<typeof other>).currency, currency) };
    const vipOverride = overrideByProduct.get(v.productId);
    return {
      variantId: v.id,
      productId: v.productId,
      productName: v.product.name,
      variantName: v.name,
      productType: v.product.type,
      activationGuide: v.product.activationGuide,
      allowPwChange: v.product.allowPasswordChange,
      reusableSecret: v.product.reusableSecretEnc ? decryptSecret(v.product.reusableSecretEnc, masterKey) : null,
      reusableStock: v.product.reusableStock,
      resellerId: v.product.resellerId,
      quantity: item.quantity,
      unitPriceMinor: vipOverride ?? effectivePriceMinor(price.amountMinor, v.product),
      fulfillmentMode: (v.fulfillmentMode ?? v.product.fulfillmentMode) as "AUTOMATIC" | "MANUAL",
    };
  });
}

/**
 * Assign one license key to an order item. When `preferReserved` is set
 * (gateway fulfillment), RESERVED rows are consumed before AVAILABLE ones.
 */
export async function assignLicenseKey(
  tx: Tx,
  variantId: string,
  orderItemId: string,
  masterKey: string,
  preferReserved = false,
  excludeIds: string[] = [],
): Promise<{ key: string; expiresAt: Date | null }> {
  const exclude = excludeIds.length > 0 ? excludeIds : ["-"];
  const statuses = preferReserved ? ["RESERVED", "AVAILABLE"] : ["AVAILABLE"];
  for (const status of statuses) {
    const rows = await tx.$queryRaw<Array<{ id: string; keyEncrypted: string; expiresAt: Date | null }>>`
      SELECT "id", "keyEncrypted", "expiresAt" FROM "LicenseKey"
      WHERE "variantId" = ${variantId} AND "status" = ${status}::"InventoryStatus" AND "deletedAt" IS NULL
        AND NOT ("id" = ANY(${exclude}::text[]))
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    const row = rows[0];
    if (!row) continue;
    await tx.licenseKey.update({
      where: { id: row.id },
      data: { status: "SOLD", soldAt: new Date(), orderItemId, reservedUntil: null },
    });
    return { key: decryptSecret(row.keyEncrypted, masterKey), expiresAt: row.expiresAt };
  }
  throw new CoreError("OUT_OF_STOCK");
}

/** Assign one digital-account slot (shared accounts: maxSlots/usedSlots). */
export async function assignAccountSlot(
  tx: Tx,
  variantId: string,
  orderItemId: string,
  masterKey: string,
  preferReserved = false,
  excludeIds: string[] = [],
): Promise<{ username: string; password: string; twofa?: string; expiresAt: Date | null }> {
  const exclude = excludeIds.length > 0 ? excludeIds : ["-"];
  const statuses = preferReserved ? ["RESERVED", "AVAILABLE"] : ["AVAILABLE"];
  for (const status of statuses) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        usernameEncrypted: string;
        passwordEncrypted: string;
        twofaEncrypted: string | null;
        expiresAt: Date | null;
        maxSlots: number;
        usedSlots: number;
      }>
    >`
      SELECT "id", "usernameEncrypted", "passwordEncrypted", "twofaEncrypted", "expiresAt", "maxSlots", "usedSlots"
      FROM "DigitalAccount"
      WHERE "variantId" = ${variantId} AND "status" = ${status}::"InventoryStatus" AND "deletedAt" IS NULL
        AND "usedSlots" < "maxSlots"
        AND NOT ("id" = ANY(${exclude}::text[]))
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    const row = rows[0];
    if (!row) continue;
    const nowFull = row.usedSlots + 1 >= row.maxSlots;
    await tx.digitalAccount.update({
      where: { id: row.id },
      data: {
        usedSlots: { increment: 1 },
        reservedUntil: null,
        ...(nowFull ? { status: "SOLD" as const } : { status: "AVAILABLE" as const }),
      },
    });
    await tx.accountAssignment.create({
      data: { accountId: row.id, orderItemId, slotLabel: `Slot ${row.usedSlots + 1}` },
    });
    return {
      username: decryptSecret(row.usernameEncrypted, masterKey),
      password: decryptSecret(row.passwordEncrypted, masterKey),
      ...(row.twofaEncrypted ? { twofa: decryptSecret(row.twofaEncrypted, masterKey) } : {}),
      expiresAt: row.expiresAt,
    };
  }
  throw new CoreError("OUT_OF_STOCK");
}

export interface DeliveryPayload {
  kind: string;
  key?: string;
  username?: string;
  password?: string;
  twofa?: string;
  expiresAt?: string;
}

/** HTML delivery message — same shape the bot renders (Bot UX doc §6). */
/**
 * Clean a pasted credential line. Pasted text often arrives auto-linked as
 * markdown ("[a@b.com](mailto:a@b.com)|pw") or HTML; splitting that raw would
 * break at the "mailto:" colon and duplicate the address.
 */
export function sanitizeCredentialLine(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/<a[^>]*>(.*?)<\/a>/gi, "$1") // <a ...>text</a> → text
    .replace(/\bmailto:/gi, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "") // zero-width junk
    .trim();
}

/**
 * Split one credential line into its parts. Separator priority — an explicit
 * "|" always wins, so a value containing a colon can never be mis-split:
 *   "user | pass"           → id + password
 *   "user | pass | SECRET"  → id + password + 2FA secret (paste at 2fa.live)
 *   "user:pass"             → id + password
 * License keys are left alone: "-" is never a separator (XXXX-XXXX-XXXX), and
 * ":" / whitespace only split when every resulting part is space-free.
 */
export function splitCredential(line: string): { id: string; pw: string; twofa?: string } | null {
  const t = sanitizeCredentialLine(line);
  if (!t) return null;

  const build = (parts: string[]): { id: string; pw: string; twofa?: string } | null => {
    const clean = parts.map((x) => x.trim()).filter((x, i) => x !== "" || i < 2);
    const [id, pw] = clean;
    if (!id || !pw) return null;
    const extra = clean.length > 2 ? clean.slice(2).filter(Boolean).join("|") : undefined;
    return { id, pw, ...(extra ? { twofa: extra } : {}) };
  };

  // "|" is the only separator allowed to contain spaces/colons — it is explicit,
  // so the admin opted in. Everything else must look unambiguously like a
  // credential pair: no spaces and no colons in any part. That keeps license
  // keys ("XKEY-1122, valid till 2027"), prose ("Note: keep this safe") and
  // URLs ("https://x/y") from ever being split into ID/Password.
  if (t.includes("|")) return build(t.split("|"));
  // For implicit separators the WHOLE line must be whitespace-free and not a
  // URL, otherwise prose ("Time: 12:30") and links ("https://x/y") get split.
  const tidy = (parts: string[]): { id: string; pw: string; twofa?: string } | null => {
    if (/\s/.test(t) || t.includes("://")) return null;
    return parts.length >= 2 && parts.length <= 3 && parts.every((x) => x !== "") ? build(parts) : null;
  };
  if (t.includes(",")) return tidy(t.split(","));
  if (t.includes(":")) return tidy(t.split(":"));
  return null;
}

/**
 * Repair a username/password pair that was stored by the OLD buggy parser.
 * That parser split at the earliest separator, so a pasted markdown email link
 * broke apart inside "mailto:" — leaving the address in BOTH fields. Rejoining
 * on ":" reconstructs the original line, which the fixed parser reads correctly.
 * Defensive: stock already saved wrong still delivers correctly.
 */
export function repairAccountPair(
  username: string | undefined,
  password: string | undefined,
): { id: string; pw: string; twofa?: string } | null {
  if (!username || !password) return null;
  const looksBroken = /\[|\]\(|mailto\s*$/i.test(username) || /\)\s*\|/.test(password);
  if (!looksBroken) return null;
  return splitCredential(`${username}:${password}`);
}

/** Clipboard values for the copy buttons — repaired and matching what is displayed. */
export function credsOf(payload: DeliveryPayload): { id?: string; pw?: string; twofa?: string; key?: string } {
  const fixed = repairAccountPair(payload.username, payload.password);
  const id = fixed?.id ?? payload.username;
  const pw = fixed?.pw ?? payload.password;
  const twofa = fixed?.twofa ?? payload.twofa;
  if (id && pw) return { id, pw, twofa };
  // A single-line key blob may itself be "id|pass[|2fa]".
  if (payload.key) {
    const rows = payload.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    if (rows.length === 1) {
      const c = splitCredential(rows[0] ?? "");
      if (c) return { id: c.id, pw: c.pw, twofa: c.twofa };
      return { key: rows[0] };
    }
  }
  return {};
}

/** The 2FA helper site customers paste the secret into. */
export const TWOFA_SITE = "https://2fa.live";


export function buildDeliveryText(
  productName: string,
  variantName: string,
  payload: DeliveryPayload,
  activationGuide?: string | null,
  allowPwChange?: boolean,
): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const vn = variantName.trim().toLowerCase() === "standard" ? "" : ` · ${esc(variantName)}`;
  const lines = ["🎉🎊 <b>Congratulations — your order is delivered!</b> 🥳", "", `📦 <b>${esc(productName)}</b>${vn}`, ""];

  let renderedCreds = false;
  if (payload.key) {
    // One delivered blob may hold several lines (multi-quantity or an account list).
    const rows = payload.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    const creds = rows.map(splitCredential);
    const allCreds = rows.length > 0 && creds.every((c) => c !== null);
    if (allCreds) {
      renderedCreds = true;
      rows.forEach((_, i) => {
        const c = creds[i] as { id: string; pw: string; twofa?: string };
        if (rows.length > 1) lines.push(`<b>━━ Account ${i + 1} ━━</b>`);
        lines.push(`👤 <b>ID:</b>  <code>${esc(c.id)}</code>`);
        lines.push(`🔐 <b>Password:</b>  <code>${esc(c.pw)}</code>`);
        if (c.twofa) lines.push(`🔢 <b>2FA secret:</b>  <code>${esc(c.twofa)}</code>`);
        if (rows.length > 1 && i < rows.length - 1) lines.push("");
      });
    } else if (rows.length > 1) {
      lines.push("🔑 <b>Your keys:</b>");
      for (const r of rows) lines.push(`<code>${esc(r)}</code>`);
    } else {
      lines.push(`🔑 <b>Key:</b> <code>${esc(payload.key)}</code>`);
    }
  }
  const fixed = repairAccountPair(payload.username, payload.password);
  const uName = fixed?.id ?? payload.username;
  const uPass = fixed?.pw ?? payload.password;
  const uTwofa = fixed?.twofa ?? payload.twofa;
  if (uName) lines.push(`👤 <b>ID:</b>  <code>${esc(uName)}</code>`);
  if (uPass) lines.push(`🔐 <b>Password:</b>  <code>${esc(uPass)}</code>`);
  if (uTwofa) lines.push(`🔢 <b>2FA secret:</b>  <code>${esc(uTwofa)}</code>`);
  if (uTwofa) {
    lines.push(
      "",
      "🔐 <b>How to get your OTP</b>",
      `1. Open <a href="${TWOFA_SITE}">2fa.live</a>`,
      "2. Paste the <b>2FA secret</b> above into the box",
      "3. Tap <b>Submit</b> — it shows a 6-digit code",
      "4. Enter that code when logging in (it refreshes every 30s)",
      "",
      "📋 <b>Copy all credentials:</b>",
      `<code>${esc(uName ?? "")}|${esc(uPass ?? "")}|${esc(uTwofa)}</code>`,
    );
  } else if (uName && uPass) {
    lines.push("", "📋 <b>Copy all credentials:</b>", `<code>${esc(uName)}|${esc(uPass)}</code>`);
  }
  if (renderedCreds && payload.key) {
    const rows = payload.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    const anyTwofa = rows.map(splitCredential).some((c) => c?.twofa);
    if (anyTwofa) {
      lines.push(
        "",
        `🔐 <b>How to get your OTP</b>`,
        `1. Open <a href="${TWOFA_SITE}">2fa.live</a>`,
        `2. Paste the <b>2FA secret</b> above into the box`,
        `3. Tap <b>Submit</b> — it shows a 6-digit code`,
        `4. Enter that code when logging in (it refreshes every 30s)`,
      );
    }
    lines.push("", "📋 <b>Copy all credentials:</b>");
    for (const r of rows) lines.push(`<code>${esc(r)}</code>`);
  }
  if (uName || renderedCreds) {
    lines.push("", "ℹ️ Tap any value above to copy it.");
    lines.push(allowPwChange ? "🔓 This account is yours — you're welcome to change the password." : "🔒 Please do <b>not</b> change the account password.");
  }
  if (payload.expiresAt) lines.push(`⏳ Valid until: ${payload.expiresAt.slice(0, 10)}`);
  if (activationGuide) lines.push("", `📄 ${esc(activationGuide)}`);
  lines.push("", "💾 <b>Saved in 📦 My Orders</b> — reopen it any time from 📦 View my orders.", "Enjoy! 🚀", "Problem? Open a 🎫 Support ticket.");
  return lines.join("\n");
}

/** Friendly display name for greetings: @handle, else first name, else "there". */
export function greetName(u: { telegramHandle?: string | null; firstName?: string | null }): string {
  const f = (u.firstName ?? "").trim();
  if (f) return f.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (u.telegramHandle) return `@${u.telegramHandle}`;
  return "there";
}

/** Warm, respectful, personalised thank-you sent after a successful purchase. */
export function thankYouMessage(u: { telegramHandle?: string | null; firstName?: string | null }, storeName: string): string {
  return [
    `🎁 <b>Thank you so much, ${greetName(u)}!</b> 🙏`,
    `It's truly an honour to serve you. We deeply appreciate your trust in ${storeName}.`,
    `Wishing you the very best — enjoy your purchase! 💙`,
  ].join("\n");
}

/** Orders with more than this many delivered items get a .txt file instead of one long chat message. */
export const DELIVERY_FILE_THRESHOLD = 15;

export interface DeliveryLine {
  productName: string;
  variantName: string;
  payload: DeliveryPayload;
  activationGuide?: string | null;
  allowPwChange?: boolean;
}

/** One consolidated HTML message for a whole multi-item order (used when count ≤ threshold). */
export function buildCombinedDeliveryText(items: DeliveryLine[], orderNumber?: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out: string[] = [`🎉🎊 <b>Your order is delivered!</b> 🥳  (${items.length} item${items.length === 1 ? "" : "s"})`];
  if (orderNumber) out.push(`🧾 Order <b>${esc(orderNumber)}</b>`);
  out.push("");
  items.forEach((it, i) => {
    const vn = it.variantName.trim().toLowerCase() === "standard" ? "" : ` · ${esc(it.variantName)}`;
    out.push(`<b>${i + 1}.</b> 📦 <b>${esc(it.productName)}</b>${vn}`);
    const p = it.payload;
    if (p.key) {
      const rows = p.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
      const creds = rows.map(splitCredential);
      if (rows.length > 0 && creds.every((c) => c !== null)) {
        rows.forEach((_, k) => {
          const c = creds[k] as { id: string; pw: string; twofa?: string };
          if (rows.length > 1) out.push(`   <b>${k + 1})</b>`);
          out.push(`   👤 ID: <code>${esc(c.id)}</code>`);
          out.push(`   🔐 Password: <code>${esc(c.pw)}</code>`);
          if (c.twofa) out.push(`   🔢 2FA secret: <code>${esc(c.twofa)}</code>  <i>(paste at 2fa.live)</i>`);
        });
        out.push(`   ${it.allowPwChange ? "🔓 Password can be changed" : "🔒 Do not change the password"}`);
      } else if (rows.length > 1) {
        for (const r of rows) out.push(`   🔑 <code>${esc(r)}</code>`);
      } else {
        out.push(`   🔑 Key: <code>${esc(p.key)}</code>`);
      }
    }
    const fx = repairAccountPair(p.username, p.password);
    const cName = fx?.id ?? p.username;
    const cPass = fx?.pw ?? p.password;
    const cTwo = fx?.twofa ?? p.twofa;
    if (cName) out.push(`   👤 ID: <code>${esc(cName)}</code>`);
    if (cPass) out.push(`   🔐 Password: <code>${esc(cPass)}</code>`);
    if (cTwo) out.push(`   🔢 2FA secret: <code>${esc(cTwo)}</code>  <i>(paste at 2fa.live)</i>`);
    if (cName && cPass) out.push(`   📋 <code>${esc(cName)}|${esc(cPass)}${cTwo ? `|${esc(cTwo)}` : ""}</code>`);
    if (p.password) out.push(`   ${it.allowPwChange ? "🔓 Password can be changed" : "🔒 Do not change the password"}`);
    if (p.expiresAt) out.push(`   ⏳ ${p.expiresAt.slice(0, 10)}`);
    out.push("");
  });
  out.push("💾 <b>Saved in 📦 My Orders</b> — reopen it any time from 📦 View my orders.", "Enjoy! 🚀", "Problem? Open a 🎫 Support ticket.");
  return out.join("\n");
}

/** Plaintext body for the .txt attachment sent for large orders (> threshold). */
export function buildDeliveryTxt(items: DeliveryLine[], orderNumber?: string): string {
  const out: string[] = [];
  out.push(`ORDER DELIVERY${orderNumber ? ` — ${orderNumber}` : ""}`);
  out.push(`${items.length} item(s)`);
  out.push("=".repeat(40), "");
  items.forEach((it, i) => {
    const vn = it.variantName.trim().toLowerCase() === "standard" ? "" : ` · ${it.variantName}`;
    out.push(`${i + 1}) ${it.productName}${vn}`);
    const p = it.payload;
    if (p.key) {
      const rows = p.key.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
      const creds = rows.map(splitCredential);
      if (rows.length > 0 && creds.every((c) => c !== null)) {
        rows.forEach((_, k) => {
          const c = creds[k] as { id: string; pw: string; twofa?: string };
          out.push(`   ${rows.length > 1 ? `${k + 1}) ` : ""}ID: ${c.id}`);
          out.push(`   ${rows.length > 1 ? "   " : ""}Password: ${c.pw}`);
          if (c.twofa) out.push(`   ${rows.length > 1 ? "   " : ""}2FA secret: ${c.twofa}   (paste at ${TWOFA_SITE} to get the OTP)`);
        });
      } else {
        for (const r of rows) out.push(`   Key: ${r}`);
      }
    }
    const fxx = repairAccountPair(p.username, p.password);
    const tName = fxx?.id ?? p.username;
    const tPass = fxx?.pw ?? p.password;
    const tTwo = fxx?.twofa ?? p.twofa;
    if (tName) out.push(`   ID: ${tName}`);
    if (tPass) out.push(`   Password: ${tPass}`);
    if (tTwo) out.push(`   2FA secret: ${tTwo}   (paste at ${TWOFA_SITE} to get the OTP)`);
    if (tName && tPass) out.push(`   Copy all: ${tName}|${tPass}${tTwo ? `|${tTwo}` : ""}`);
    if (p.expiresAt) out.push(`   Valid until: ${p.expiresAt.slice(0, 10)}`);
    if (it.activationGuide) out.push(`   Note: ${it.activationGuide}`);
    out.push("");
  });
  out.push("Saved in My Orders in the bot - reopen any time. Problem? Open a Support ticket.");
  return out.join("\n");
}
