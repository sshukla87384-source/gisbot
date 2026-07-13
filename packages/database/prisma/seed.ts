/**
 * Seed script (idempotent).
 * Always: system roles, permission catalog, price tiers, default settings.
 * Non-production only: demo catalog + encrypted demo license keys.
 */
import { loadConfig } from "@gis/config";
import { encryptSecret, normalizeLicenseKey, sha256Hex } from "@gis/shared";
import { hash as argonHash } from "@node-rs/argon2";
import { ensureDbObjects, prisma } from "../src/index.js";

const PERMISSIONS: Array<{ key: string; group: string }> = [
  { key: "catalog.read", group: "catalog" },
  { key: "catalog.write", group: "catalog" },
  { key: "catalog.approve", group: "catalog" },
  { key: "pricing.write", group: "catalog" },
  { key: "inventory.read", group: "inventory" },
  { key: "inventory.write", group: "inventory" },
  { key: "inventory.import", group: "inventory" },
  { key: "inventory.export", group: "inventory" },
  { key: "inventory.reveal", group: "inventory" },
  { key: "orders.read", group: "orders" },
  { key: "orders.fulfill", group: "orders" },
  { key: "orders.cancel", group: "orders" },
  { key: "payments.read", group: "payments" },
  { key: "payments.refund", group: "payments" },
  { key: "wallets.read", group: "wallets" },
  { key: "wallets.adjust", group: "wallets" },
  { key: "wallets.withdraw.review", group: "wallets" },
  { key: "users.read", group: "users" },
  { key: "users.moderate", group: "users" },
  { key: "resellers.manage", group: "resellers" },
  { key: "coupons.read", group: "coupons" },
  { key: "coupons.write", group: "coupons" },
  { key: "tickets.read", group: "support" },
  { key: "tickets.write", group: "support" },
  { key: "broadcasts.send", group: "messaging" },
  { key: "templates.write", group: "messaging" },
  { key: "analytics.read", group: "analytics" },
  { key: "settings.write", group: "platform" },
  { key: "roles.manage", group: "platform" },
  { key: "roles.assign", group: "platform" },
  { key: "audit.read", group: "platform" },
  { key: "apikeys.manage", group: "platform" },
  { key: "platform.backup", group: "platform" },
  { key: "media.write", group: "platform" },
];

const ROLE_GRANTS: Record<string, string[] | "ALL"> = {
  SUPER_ADMIN: "ALL",
  ADMIN: PERMISSIONS.map((p) => p.key).filter((k) => !["roles.manage", "platform.backup", "apikeys.manage"].includes(k)),
  SUPPORT: ["tickets.read", "tickets.write", "orders.read", "users.read"],
  FINANCE: ["payments.read", "payments.refund", "wallets.read", "wallets.adjust", "wallets.withdraw.review", "analytics.read"],
  RESELLER: [],
  CUSTOMER: [],
};

async function seedRbac(): Promise<void> {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, create: p, update: { group: p.group } });
  }
  const allPerms = await prisma.permission.findMany();
  for (const [name, grants] of Object.entries(ROLE_GRANTS)) {
    const role = await prisma.role.upsert({
      where: { name },
      create: { name, isSystem: true },
      update: { isSystem: true },
    });
    const keys = grants === "ALL" ? allPerms.map((p) => p.key) : grants;
    for (const key of keys) {
      const perm = allPerms.find((p) => p.key === key);
      if (!perm) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        create: { roleId: role.id, permissionId: perm.id },
        update: {},
      });
    }
  }
}

async function seedTiersAndSettings(): Promise<void> {
  for (const name of ["RETAIL", "RESELLER_L1"]) {
    await prisma.priceTier.upsert({ where: { name }, create: { name }, update: {} });
  }
  const defaults: Record<string, unknown> = {
    "orders.payment_window_minutes": 15,
    "referral.reward_pct_bp": 500,
    "referral.hold_hours": 48,
    "reseller.commission_pct_bp": 1000,
    "reseller.hold_days": 7,
    "downloads.default_ttl_hours": 24,
    "downloads.default_limit": 3,
    "bot.broadcast_rate_per_sec": 25,
    "maintenance.enabled": false,
  };
  for (const [key, value] of Object.entries(defaults)) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: {},
    });
  }
}

async function seedDemoCatalog(masterKey: string): Promise<void> {
  const retail = await prisma.priceTier.findUniqueOrThrow({ where: { name: "RETAIL" } });

  const softwareCat = await prisma.category.upsert({
    where: { slug: "software-keys" },
    create: { name: "Software Keys", slug: "software-keys", emoji: "🔑", sortOrder: 1 },
    update: {},
  });
  const streamingCat = await prisma.category.upsert({
    where: { slug: "streaming" },
    create: { name: "Streaming", slug: "streaming", emoji: "📺", sortOrder: 2 },
    update: {},
  });

  const win = await prisma.product.upsert({
    where: { slug: "windows-11-pro" },
    create: {
      slug: "windows-11-pro",
      name: "Windows 11 Pro Key",
      description: "Genuine retail activation key for Windows 11 Pro. Instant delivery.",
      type: "LICENSE_KEY",
      status: "ACTIVE",
      categoryId: softwareCat.id,
      fulfillmentMode: "AUTOMATIC",
      isFeatured: true,
      sourcingNote: "DEMO DATA — replace with real, authorized-channel stock.",
      activationGuide: "Settings → System → Activation → Change product key.",
    },
    update: {},
  });
  const winVar = await prisma.productVariant.upsert({
    where: { sku: "WIN11-PRO-RETAIL" },
    create: { productId: win.id, name: "Retail Key", sku: "WIN11-PRO-RETAIL", lowStockThreshold: 3 },
    update: {},
  });

  const netflix = await prisma.product.upsert({
    where: { slug: "netflix-premium" },
    create: {
      slug: "netflix-premium",
      name: "Netflix Premium",
      description: "Netflix Premium 4K plan. DEMO listing.",
      type: "LICENSE_KEY",
      status: "ACTIVE",
      categoryId: streamingCat.id,
      fulfillmentMode: "AUTOMATIC",
      isFeatured: true,
      sourcingNote: "DEMO DATA — subscription resale must comply with provider ToS.",
    },
    update: {},
  });
  const netflixVar = await prisma.productVariant.upsert({
    where: { sku: "NFLX-PREM-1M" },
    create: { productId: netflix.id, name: "1 Month Voucher", sku: "NFLX-PREM-1M", durationDays: 30 },
    update: {},
  });

  const prices: Array<{ variantId: string; currency: "INR" | "USD"; amountMinor: number }> = [
    { variantId: winVar.id, currency: "INR", amountMinor: 89_900 },
    { variantId: winVar.id, currency: "USD", amountMinor: 12_99 },
    { variantId: netflixVar.id, currency: "INR", amountMinor: 19_900 },
    { variantId: netflixVar.id, currency: "USD", amountMinor: 3_49 },
  ];
  for (const p of prices) {
    await prisma.variantPrice.upsert({
      where: { variantId_tierId_currency: { variantId: p.variantId, tierId: retail.id, currency: p.currency } },
      create: { ...p, tierId: retail.id },
      update: { amountMinor: p.amountMinor },
    });
  }

  const demoKeys: Array<{ variantId: string; plain: string }> = [
    { variantId: winVar.id, plain: "DEMO1-11111-AAAAA-BBBBB-CCCCC" },
    { variantId: winVar.id, plain: "DEMO2-22222-AAAAA-BBBBB-CCCCC" },
    { variantId: winVar.id, plain: "DEMO3-33333-AAAAA-BBBBB-CCCCC" },
    { variantId: netflixVar.id, plain: "NFLX-DEMO-0001-XXXX" },
    { variantId: netflixVar.id, plain: "NFLX-DEMO-0002-XXXX" },
  ];
  for (const k of demoKeys) {
    const keyHash = sha256Hex(normalizeLicenseKey(k.plain));
    const exists = await prisma.licenseKey.findUnique({
      where: { variantId_keyHash: { variantId: k.variantId, keyHash } },
    });
    if (!exists) {
      await prisma.licenseKey.create({
        data: {
          variantId: k.variantId,
          keyEncrypted: encryptSecret(k.plain, masterKey),
          keyHash,
          supplier: "seed-demo",
        },
      });
    }
  }
}

async function seedSuperAdmin(email: string, password: string): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: "SUPER_ADMIN" } });
  const passwordHash = await argonHash(password, { memoryCost: 65536, timeCost: 3, parallelism: 4 });
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      emailVerified: true,
      passwordHash,
      firstName: "Admin",
      currency: "INR",
      wallet: { create: { currency: "INR" } },
    },
    update: { passwordHash },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    create: { userId: user.id, roleId: role.id },
    update: {},
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureDbObjects();
  await seedRbac();
  await seedTiersAndSettings();
  if (config.SEED_ADMIN_EMAIL && config.SEED_ADMIN_PASSWORD) {
    await seedSuperAdmin(config.SEED_ADMIN_EMAIL, config.SEED_ADMIN_PASSWORD);
  }
  if (config.NODE_ENV !== "production") {
    await seedDemoCatalog(config.ENCRYPTION_MASTER_KEY);
    // eslint-disable-next-line no-console
    console.log("Seeded RBAC, tiers, settings and demo catalog (non-production).");
  } else {
    // eslint-disable-next-line no-console
    console.log("Seeded RBAC, tiers and settings.");
  }
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
