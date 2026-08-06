import { cached, getRedis } from "../redis.js";
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

/**
 * Role names for a user, cached briefly.
 *
 * This runs in the bot middleware, so it fired a second sequential DB round trip
 * on EVERY button tap. Roles change approximately never, so a short cache
 * removes the query from the hot path entirely without any staleness that
 * matters — and a cache failure just falls through to the query.
 */
async function withRoleNames(user: User): Promise<User & { roleNames: string[] }> {
  const names = await cached(`role:u:${user.id}`, 120, async () => {
    const roles = await prisma.userRole.findMany({
      where: { userId: user.id },
      include: { role: { select: { name: true } } },
    });
    return roles.map((r) => r.role.name);
  }).catch(async () => {
    const roles = await prisma.userRole.findMany({ where: { userId: user.id }, include: { role: { select: { name: true } } } });
    return roles.map((r) => r.role.name);
  });
  return Object.assign(user, { roleNames: names });
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

  const currency = "USD" as Currency; // new users default to USD (changeable in menu)
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

export async function setUserLocale(userId: string, locale: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { locale } });
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

/**
 * Once a day, not once an order.
 *
 * The nudge was sent after EVERY delivery, so a customer buying five things in
 * an afternoon got the same "share & earn" pitch five times. That reads as
 * spam and it trains people to ignore the referral programme entirely. This
 * returns true only for a user's first delivery of the day.
 *
 * Redis with a TTL to the end of the day, so it costs one key per buyer per day
 * and self-cleans. Failing open would restore the spam, so on a Redis error we
 * stay quiet instead.
 */
export async function shouldSendReferralNudge(userId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const day = new Date().toISOString().slice(0, 10);
    const key = `ref:nudged:${day}:${userId}`;
    const first = await redis.set(key, "1", "EX", 172_800, "NX");
    return first !== null;
  } catch {
    return false;
  }
}

/** "Share & earn" nudge shown after a successful purchase (null if not configurable). */
export function referralNudgeMessage(referralCode: string | null | undefined, botUsername: string | null | undefined): string | null {
  if (!botUsername || !referralCode) return null;
  const link = `https://t.me/${botUsername}?start=ref_${referralCode}`;
  return [
    "💛 <b>Enjoyed your purchase? Share &amp; earn!</b>",
    "Invite friends with your personal link and earn wallet rewards when they make their first purchase:",
    `<code>${link}</code>`,
  ].join("\n");
}
