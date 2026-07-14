import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { enqueueTelegramMessage, type OutboxButton } from "./queues.js";
import { effectivePriceMinor, isSaleActive } from "./pricing.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtMinor(amountMinor: number, currency: string): string {
  const sym = currency === "INR" ? "₹" : currency === "USD" ? "$" : "";
  return `${sym}${(amountMinor / 100).toFixed(2)}`;
}

export async function registerPostTarget(chatId: string, title: string | null, addedById?: string): Promise<void> {
  await prisma.postTarget.upsert({
    where: { chatId },
    create: { chatId, title, addedById, active: true },
    update: { title, active: true },
  });
}

export async function removePostTarget(id: string): Promise<void> {
  await prisma.postTarget.deleteMany({ where: { id } });
}

export async function removePostTargetByChat(chatId: string): Promise<void> {
  await prisma.postTarget.deleteMany({ where: { chatId } });
}

export async function listPostTargets(): Promise<Array<{ id: string; chatId: string; title: string | null; active: boolean }>> {
  return prisma.postTarget.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, chatId: true, title: true, active: true } });
}

/** Build a product "post" (caption + image + Buy-Now deep-link button). */
async function buildProductPost(productId: string): Promise<{ caption: string; imageUrl?: string; buttons?: OutboxButton[] } | null> {
  const cfg = loadConfig();
  const p = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: { where: { isActive: true, deletedAt: null }, include: { prices: { where: { tier: { name: "RETAIL" } } } } } },
  });
  if (!p || p.status !== "ACTIVE" || p.deletedAt) return null;

  const onSale = isSaleActive(p);
  const all = p.variants.flatMap((v) => v.prices);
  const inr = all.filter((pr) => pr.currency === "INR");
  const picks = (inr.length > 0 ? inr : all).map((pr) => ({ currency: pr.currency, minor: effectivePriceMinor(pr.amountMinor, p) }));
  const cheapest = picks.length > 0 ? picks.reduce((a, b) => (b.minor < a.minor ? b : a)) : null;

  // Live stock for unit-stocked products.
  const variantIds = p.variants.map((v) => v.id);
  let stock: number | null = null;
  if (p.type === "LICENSE_KEY") stock = await prisma.licenseKey.count({ where: { variantId: { in: variantIds }, status: "AVAILABLE", deletedAt: null } });
  else if (p.type === "DIGITAL_ACCOUNT") stock = await prisma.digitalAccount.count({ where: { variantId: { in: variantIds }, status: "AVAILABLE", deletedAt: null } });

  const icon = p.iconEmoji ? `${p.iconEmoji} ` : "⭐ ";
  const lines: string[] = [];
  if (p.fulfillmentMode === "AUTOMATIC") lines.push("🛒 <b>INSTANT DELIVERY</b> ⚡", "");
  lines.push(`${icon}<b>${esc(p.name)}</b>`, "");
  if (onSale && p.salePercentBp) lines.push(`🔥 <b>FLASH SALE — ${Math.round(p.salePercentBp / 100)}% OFF</b>`, "");
  if (cheapest) lines.push(`💰 <b>Price: ${fmtMinor(cheapest.minor, cheapest.currency)}</b>`, "");
  if (stock !== null) lines.push(`📦 In stock: <b>${stock}</b>`, "");
  if (p.description) {
    for (const line of p.description.split("\n").map((l) => l.trim()).filter(Boolean)) lines.push(`✅ ${esc(line)}`);
  }

  const buttons: OutboxButton[] | undefined = cfg.BOT_USERNAME
    ? [{ text: onSale ? "⚡ Buy Now 🔥" : "⚡ Buy Now", url: `https://t.me/${cfg.BOT_USERNAME}?start=p_${p.slug}` }]
    : undefined;

  return { caption: lines.join("\n"), imageUrl: p.imageUrl ?? undefined, buttons };
}

/** Post a product to all active registered groups/channels. Returns count posted. */
export async function postProductToGroups(productId: string): Promise<number> {
  const post = await buildProductPost(productId);
  if (!post) return 0;
  const targets = await prisma.postTarget.findMany({ where: { active: true } });
  let sent = 0;
  for (const t of targets) {
    await enqueueTelegramMessage(t.chatId, post.caption, { photo: post.imageUrl, buttons: post.buttons });
    sent++;
  }
  return sent;
}
