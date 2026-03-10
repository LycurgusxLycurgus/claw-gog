import { getEnv } from "../app/env";

const COOKIE_NAME = "bridgeclaw_admin";

export function validateAdminPassword(password: string) {
  return password === getEnv().ADMIN_PASSWORD;
}

export function createAdminCookie() {
  return `${COOKIE_NAME}=ok; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`;
}

export function readAdminCookie(cookieHeader: string | null) {
  return cookieHeader?.includes(`${COOKIE_NAME}=ok`) ?? false;
}
