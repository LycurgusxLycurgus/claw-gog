import { action } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { getEnv } from "../app/env";
import { formatDigest } from "../calendar/formatDigest";
import { listWeekAgenda } from "../calendar/listWeekAgenda";
import { getValidGoogleAccessToken } from "../calendar/oauth";
import { sendTelegramMessage } from "../telegram/sendMessage";

export function buildDailyDigest(events: Array<{ summary: string; start: string; location?: string }>, options: { locale: string; timeZone: string }) {
  return formatDigest(events, options);
}

export const runDailyDigest = action({
  args: {},
  handler: async (ctx): Promise<string> => {
    const env = getEnv();
    const accessToken = await getValidGoogleAccessToken(ctx, env.APP_OWNER_KEY);
    if (!accessToken) {
      return "Google Calendar is not connected yet.";
    }

    const appConfig = await ctx.runQuery(internal.calendar.oauth.getAppConfig, {
      ownerKey: env.APP_OWNER_KEY,
    });

    const locale = appConfig?.locale ?? env.DEFAULT_LOCALE;
    const timeZone = appConfig?.timezone ?? env.DEFAULT_TIMEZONE;
    const chatId = appConfig?.telegramDigestChatId ?? env.TELEGRAM_DEFAULT_CHAT_ID;
    const calendarId = appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID;
    const events = await listWeekAgenda(accessToken, calendarId);
    const digest = buildDailyDigest(events, { locale, timeZone });

    await sendTelegramMessage(chatId, digest);

    return digest;
  },
});
