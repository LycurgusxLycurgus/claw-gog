import { getEnv } from "../app/env";

export function verifyTelegramSecret(secret: string) {
  return secret === getEnv().TELEGRAM_WEBHOOK_SECRET;
}

export function isAllowedTelegramUser(userId: string) {
  return userId === getEnv().TELEGRAM_ALLOWED_USER_ID;
}
