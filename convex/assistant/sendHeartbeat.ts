import { action } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { getEnv } from "../app/env";
import { listAgendaRangeAcrossCalendars } from "../calendar/listWeekAgenda";
import { getValidGoogleAccessToken, resolveSelectedCalendarIds } from "../calendar/oauth";
import { formatDurationFromNow } from "../shared/time";
import { sendTelegramMessage } from "../telegram/sendMessage";

function endOfToday() {
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  return now;
}

function formatHeartbeat(events: Array<{ summary: string; start: string; end?: string; location?: string }>, options: { locale: string; timeZone: string }) {
  if (events.length === 0) {
    return "Heartbeat\n\nNo more events are scheduled for the rest of today.";
  }

  const now = new Date();
  const nextEvent = events.find((event) => new Date(event.start).getTime() >= now.getTime()) ?? events[0];
  const dateFormatter = new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone,
    hour: "numeric",
    minute: "2-digit",
  });

  const lines = ["Heartbeat", "", "Remaining today"];
  for (const event of events) {
    const start = dateFormatter.format(new Date(event.start));
    const end = event.end ? dateFormatter.format(new Date(event.end)) : "";
    const timeLabel = end ? `${start} - ${end}` : start;
    const locationLabel = event.location ? ` @ ${event.location}` : "";
    lines.push(`- ${timeLabel} | ${event.summary}${locationLabel}`);
  }

  if (new Date(nextEvent.start).getTime() <= now.getTime()) {
    lines.push("");
    lines.push(`Next event is in progress: ${nextEvent.summary}.`);
  } else {
    lines.push("");
    lines.push(`Next event starts in ${formatDurationFromNow(nextEvent.start, now)}: ${nextEvent.summary}.`);
  }

  return lines.join("\n");
}

export const runHeartbeat = action({
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

    const [appConfig, connection] = await Promise.all([
      ctx.runQuery(internal.calendar.oauth.getAppConfig, {
        ownerKey: env.APP_OWNER_KEY,
      }),
      ctx.runQuery(internal.calendar.oauth.getGoogleConnection, {
        ownerKey: env.APP_OWNER_KEY,
      }),
    ]);

    const timeZone = appConfig?.timezone ?? env.DEFAULT_TIMEZONE;
    const locale = appConfig?.locale ?? env.DEFAULT_LOCALE;
    const chatId = appConfig?.telegramDigestChatId ?? env.TELEGRAM_DEFAULT_CHAT_ID;
    const selectedCalendarIds = resolveSelectedCalendarIds({
      availableCalendarIds: connection?.calendarIds ?? [],
      selectedCalendarIds: appConfig?.googleCalendarSelectedIds ?? [],
      defaultCalendarId: appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID,
    });

    const events = await listAgendaRangeAcrossCalendars(accessToken, new Date(), endOfToday(), selectedCalendarIds);
    const message = formatHeartbeat(events, { locale, timeZone });

    await sendTelegramMessage(chatId, message);
    return message;
  },
});
