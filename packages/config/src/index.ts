import { z } from "zod";

/**
 * Typed, validated environment configuration.
 * The process refuses to boot on missing/malformed variables (Security doc §4).
 * Optional gateway/email/S3 groups gate feature enablement at runtime
 * (e.g. Razorpay appears as a payment option only when its vars are set).
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),

    // ── Telegram ──
    BOT_TOKEN: z.string().min(30, "BOT_TOKEN looks invalid"),
    BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
    WEBHOOK_DOMAIN: z.string().url().optional(),
    WEBHOOK_SECRET_PATH: z.string().min(16).optional(),
    TELEGRAM_SECRET_TOKEN: z.string().min(16).optional(),
    /** Telegram chat id of the admin alert channel/group (optional). */
    ADMIN_ALERT_CHAT_ID: z.string().optional(),

    // ── Crypto / auth ──
    ENCRYPTION_MASTER_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_MASTER_KEY must be 32 bytes hex (64 chars)"),
    JWT_SECRET: z.string().min(32).optional(),
    JWT_ACCESS_TTL_MIN: z.coerce.number().int().positive().default(15),
    REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

    // ── HTTP ──
    PORT: z.coerce.number().int().positive().default(8081), // bot webhook server
    API_PORT: z.coerce.number().int().positive().default(8080),
    PUBLIC_API_URL: z.string().url().optional(), // payment redirects / webhook base
    ADMIN_PANEL_ORIGIN: z.string().url().default("http://localhost:3000"),

    // ── Seed super admin (used by db:seed; required for admin panel login) ──
    SEED_ADMIN_EMAIL: z.string().email().optional(),
    SEED_ADMIN_PASSWORD: z.string().min(12).optional(),

    // ── Payment gateways (optional groups) ──
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // ── Email (Resend) ──
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(), // e.g. "Get It Sasta <no-reply@getitsasta.com>"

    // ── S3-compatible storage (optional until media/download phases) ──
    S3_ENDPOINT: z.string().url().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.BOT_MODE === "webhook") {
      for (const key of ["WEBHOOK_DOMAIN", "WEBHOOK_SECRET_PATH", "TELEGRAM_SECRET_TOKEN"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when BOT_MODE=webhook`,
          });
        }
      }
    }
    if (env.NODE_ENV === "production" && /^0+$/.test(env.ENCRYPTION_MASTER_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ENCRYPTION_MASTER_KEY"],
        message: "Refusing to run production with the placeholder master key",
      });
    }
    const razorpayVars = [env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET];
    if (razorpayVars.some(Boolean) && !razorpayVars.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RAZORPAY_KEY_ID"],
        message: "Set all of RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET or none",
      });
    }
    const stripeVars = [env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET];
    if (stripeVars.some(Boolean) && !stripeVars.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STRIPE_SECRET_KEY"],
        message: "Set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET or neither",
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

/** For the API app: JWT_SECRET is mandatory. */
export function requireJwtSecret(): string {
  const config = loadConfig();
  if (!config.JWT_SECRET) {
    // eslint-disable-next-line no-console
    console.error("JWT_SECRET is required to run the API");
    process.exit(1);
  }
  return config.JWT_SECRET;
}

export const isProd = () => loadConfig().NODE_ENV === "production";
export const isDev = () => loadConfig().NODE_ENV === "development";
