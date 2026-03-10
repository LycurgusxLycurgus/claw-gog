export function requireAdmin(session: { isAdmin?: boolean }) {
  if (!session?.isAdmin) {
    return { status: 403, code: "FORBIDDEN", message: "Admin session required" };
  }

  return null;
}

export function requireAllowedTelegramSender(allowed: boolean) {
  if (!allowed) {
    return { status: 403, code: "SENDER_NOT_ALLOWED", message: "Telegram sender is not allowlisted" };
  }

  return null;
}
