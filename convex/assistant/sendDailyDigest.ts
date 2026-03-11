import { action } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { getEnv } from "../app/env";
import { formatDigest } from "../calendar/formatDigest";
import { listWeekAgendaAcrossCalendars } from "../calendar/listWeekAgenda";
import { getValidGoogleAccessToken, resolveSelectedCalendarIds } from "../calendar/oauth";
import { sendTelegramMessage } from "../telegram/sendMessage";

export function buildDailyDigest(events: Array<{ summary: string; start: string; location?: string }>, options: { locale: string; timeZone: string }) {
  return formatDigest(events, options);
}

function buildDailyNote(events: Array<{ summary: string; start: string }>, options: { locale: string; timeZone: string }) {
  if (events.length === 0) {
    return "No events in the selected 7-day calendar window.";
  }

  const top = events.slice(0, 3).map((event) => {
    const when = new Intl.DateTimeFormat(options.locale, {
      timeZone: options.timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(event.start));
    return `${when} ${event.summary}`;
  });

  const suffix = events.length > 3 ? ` +${events.length - 3} more` : "";
  return `7-day focus: ${top.join(" | ")}${suffix}`;
}

export const runDailyDigest = action({
  args: {},
  handler: async (ctx): Promise<string> => {
    const env = getEnv();
    await ctx.runMutation(internal.context.workspace.ensureWorkspaceState, {
      ownerKey: env.APP_OWNER_KEY,
    });
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
    const connection = await ctx.runQuery(internal.calendar.oauth.getGoogleConnection, {
      ownerKey: env.APP_OWNER_KEY,
    });
    const selectedCalendarIds = resolveSelectedCalendarIds({
      availableCalendarIds: connection?.calendarIds ?? [],
      selectedCalendarIds: appConfig?.googleCalendarSelectedIds ?? [],
      defaultCalendarId: appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID,
    });
    const events = await listWeekAgendaAcrossCalendars(accessToken, selectedCalendarIds);
    const digest = buildDailyDigest(events, { locale, timeZone });
    const noteDate = new Date().toISOString().slice(0, 10);

    await sendTelegramMessage(chatId, digest);
    await ctx.runMutation(internal.context.workspace.upsertDailyNote, {
      ownerKey: env.APP_OWNER_KEY,
      noteDate,
      body: buildDailyNote(events, { locale, timeZone }),
      generatedBy: "assistant",
    });

    return digest;
  },
});
