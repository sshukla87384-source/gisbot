import { z } from "zod";

/**
 * Typed, validated environment configuration.
 * The process refuses to boot on missing/malformed variables (Security doc §4).
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),

    BOT_TOKEN: z.string().min(30, "BOT_TOKEN looks invalid"),
    BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
    WEBHOOK_DOMAIN: z.string().url().optional(),
    WEBHOOK_SECRET_PATH: z.string().min(16).optional(),
    TELEGRAM_SECRET_TOKEN: z.string().min(16).optional(),

    ENCRYPTION_MASTER_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_MASTER_KEY must be 32 bytes hex (64 chars)"),

    PORT: z.coerce.number().int().positive().default(8081),
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

export const isProd = () => loadConfig().NODE_ENV === "production";
export const isDev = () => loadConfig().NODE_ENV === "development";
