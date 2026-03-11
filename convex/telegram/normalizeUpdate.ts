export type NormalizedTelegramUpdate = {
  chatId: string;
  messageId: string;
  text: string;
  userId: string;
  username?: string;
  displayName?: string;
};

export function normalizeUpdate(payload: Record<string, any>): NormalizedTelegramUpdate | null {
  const message = payload.message ?? payload.edited_message;
  if (!message?.chat?.id || !message?.from?.id || typeof message.text !== "string") {
    return null;
  }

  return {
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    text: message.text.trim(),
    userId: String(message.from.id),
    username: message.from.username,
    displayName: message.from.first_name ?? message.chat.first_name ?? message.from.username,
  };
}
