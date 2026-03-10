import { z } from "zod";

const EnvSchema = z.object({
  APP_BASE_URL: z.string().url(),
  APP_OWNER_KEY: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8),
  CONVEX_URL: z.string().url(),
  DEFAULT_LOCALE: z.string().min(2),
  DEFAULT_TIMEZONE: z.string().min(3),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1),
  GOOGLE_CALENDAR_DEFAULT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),
  TELEGRAM_ALLOWED_USER_ID: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_DEFAULT_CHAT_ID: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(8),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cachedEnv: AppEnv | null = null;

export function getEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cachedEnv && source === process.env) {
    return cachedEnv;
  }

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment: ${message}`);
  }

  if (source === process.env) {
    cachedEnv = parsed.data;
  }

  return parsed.data;
}
