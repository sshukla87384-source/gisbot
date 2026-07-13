import { prisma, type Currency, type User } from "@gis/database";
import { REFERRAL_PREFIX } from "@gis/shared";

export interface TelegramIdentity {
  telegramId: bigint;
  firstName?: string;
  lastName?: string;
  username?: string;
  locale?: string;
  startPayload?: string;
}

export interface ResolvedUser {
  user: User & { roleNames: string[] };
  isNew: boolean;
}

function defaultCurrencyForLocale(locale?: string): Currency {
  // India-first default (PRD §6.2); USD for clearly non-Indian locales.
  if (!locale) return "INR";
  const l = locale.toLowerCase();
  return l === "hi" || l.endsWith("-in") || l === "en" ? "INR" : "USD";
}

async function withRoleNames(user: User): Promise<User & { roleNames: string[] }> {
  const roles = await prisma.userRole.findMany({
    where: { userId: user.id },
    include: { role: { select: { name: true } } },
  });
  return Object.assign(user, { roleNames: roles.map((r) => r.role.name) });
}

/**
 * Find-or-create a user from a Telegram update (Bot UX doc §2).
 * New users get: CUSTOMER role, wallet, immutable first-touch referral attribution.
 */
export async function resolveTelegramUser(input: TelegramIdentity): Promise<ResolvedUser> {
  const existing = await prisma.user.findUnique({ where: { telegramId: input.telegramId } });
  if (existing) {
    const needsUpdate =
      existing.firstName !== (input.firstName ?? existing.firstName) ||
      existing.telegramHandle !== (input.username ?? existing.telegramHandle);
    const user = needsUpdate
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            firstName: input.firstName ?? existing.firstName,
            lastName: input.lastName ?? existing.lastName,
            telegramHandle: input.username ?? existing.telegramHandle,
            notifiable: true,
          },
        })
      : existing;
    return { user: await withRoleNames(user), isNew: false };
  }

  // Referral attribution — first touch, validated, immune to self-referral.
  let referredById: string | undefined;
  if (input.startPayload?.startsWith(REFERRAL_PREFIX)) {
    const code = input.startPayload.slice(REFERRAL_PREFIX.length);
    const referrer = await prisma.user.findUnique({ where: { referralCode: code } });
    if (referrer && referrer.telegramId !== input.telegramId) referredById = referrer.id;
  }

  const currency = defaultCurrencyForLocale(input.locale);
  const customerRole = await prisma.role.findUnique({ where: { name: "CUSTOMER" } });

  const user = await prisma.user.create({
    data: {
      telegramId: input.telegramId,
      firstName: input.firstName,
      lastName: input.lastName,
      telegramHandle: input.username,
      locale: input.locale ?? "en",
      currency,
      referredById,
      wallet: { create: { currency } },
      ...(customerRole ? { roles: { create: { roleId: customerRole.id } } } : {}),
    },
  });

  await prisma.activityLog.create({
    data: { userId: user.id, event: "bot.start", meta: { referred: Boolean(referredById) } },
  });

  return { user: await withRoleNames(user), isNew: true };
}

export async function setUserCurrency(userId: string, currency: Currency): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { currency } });
}

export async function getReferralStats(userId: string): Promise<{
  invited: number;
  purchased: number;
  earnedMinor: bigint;
}> {
  const [invited, purchased, rewards] = await Promise.all([
    prisma.user.count({ where: { referredById: userId } }),
    prisma.user.count({ where: { referredById: userId, firstPurchaseAt: { not: null } } }),
    prisma.referralReward.aggregate({
      where: { referrerId: userId, status: "CREDITED" },
      _sum: { amountMinor: true },
    }),
  ]);
  return { invited, purchased, earnedMinor: BigInt(rewards._sum.amountMinor ?? 0) };
}
