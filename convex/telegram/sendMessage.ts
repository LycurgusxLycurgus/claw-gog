import { getEnv } from "../app/env";

const TELEGRAM_MESSAGE_LIMIT = 4000;

function chunkTelegramText(text: string) {
  const normalized = text.trim() || "I do not have a response yet.";
  if (normalized.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (splitAt < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      splitAt = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (splitAt < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      splitAt = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export async function sendTelegramMessage(chatId: string, text: string) {
  const env = getEnv();
  const chunks = chunkTelegramText(text);
  const responses = [];

  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });

    const bodyText = await response.text();
    let parsedBody: unknown = bodyText;

    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      parsedBody = bodyText;
    }

    if (!response.ok) {
      throw new Error(`Telegram send failed with ${response.status}: ${bodyText}`);
    }

    responses.push(parsedBody);
  }

  return responses;
}
