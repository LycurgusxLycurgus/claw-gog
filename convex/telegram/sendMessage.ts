import { getEnv } from "../app/env";

export async function sendTelegramMessage(chatId: string, text: string) {
  const env = getEnv();
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!response.ok) {
    throw new Error(`Telegram send failed with ${response.status}`);
  }

  return response.json();
}
