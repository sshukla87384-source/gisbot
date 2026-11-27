import { loadConfig } from "@gis/config";

/**
 * Links to the web shop, kept in one place so every 🌐 button in the bot
 * (menu, quick bar, each product) opens the right page.
 *
 * Its address: https://<SHOP_DOMAIN>/ once an own domain is set in .env,
 * else https://api.<domain>/shop (the API host, which already has its
 * certificate).
 */

function shopDomain(): string | null {
  const d = (process.env.SHOP_DOMAIN ?? "").trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "").toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

function apiBase(): string | null {
  const api = (loadConfig().PUBLIC_API_URL ?? "").replace(/\/+$/, "");
  return /^https:\/\//i.test(api) ? api : null;
}

/** The web shop's home page, or null when the server has no public https address. */
export function webShopBaseUrl(): string | null {
  const d = shopDomain();
  if (d) return `https://${d}/`;
  const api = apiBase();
  return api ? `${api}/shop` : null;
}

/** True when a link points at OUR web shop (either address), not some other website. */
export function isWebShopUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  const d = shopDomain();
  if (d && (host === d || host === `www.${d}`) && path === "") return true;
  const api = apiBase();
  if (api) {
    try { if (new URL(api).hostname.toLowerCase() === host && path === "/shop") return true; } catch { /* ignore */ }
  }
  return false;
}

/** Opens the web shop straight on this product (the page reads ?p=<slug or id>). */
export function webShopProductUrl(slugOrId: string): string | null {
  const base = webShopBaseUrl();
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set("p", slugOrId);
  return u.toString();
}

/**
 * What the shop-wide 🌐 button opens: the website the admin set; when that is
 * our web shop, its CURRENT address (so moving to an own domain updates every
 * button); when nothing is set and the web shop is on, the web shop.
 */
export function effectiveShopWebsite(setting: string | null | undefined, webShopOn: boolean): string | null {
  const s = (setting ?? "").trim();
  if (s) return isWebShopUrl(s) ? (webShopBaseUrl() ?? s) : s;
  return webShopOn ? webShopBaseUrl() : null;
}

/**
 * A product's "🌐 Buy on our website" link: its own link if it has one; else,
 * when the shop's website is the web shop, that product's page there (not
 * just the home page); else the shop's website.
 */
export function productWebsiteLink(own: string | null | undefined, slugOrId: string, setting: string | null | undefined, webShopOn: boolean): string | null {
  if (own?.trim()) return own.trim();
  const site = effectiveShopWebsite(setting, webShopOn);
  if (!site) return null;
  if (isWebShopUrl(site)) return webShopProductUrl(slugOrId) ?? site;
  return site;
}
