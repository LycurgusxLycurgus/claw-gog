import { action, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api.js";
import { v } from "convex/values";
import { decideAction } from "../assistant/decide";
import { composePrompt } from "../assistant/composePrompt";
import { askGemini, runGeminiScheduleLoop } from "../ai/gemini";
import { getEnv } from "../app/env";
import { listAgendaRangeAcrossCalendars } from "../calendar/listWeekAgenda";
import { fetchCalendarListEntries, getValidGoogleAccessToken, resolveSelectedCalendarIds } from "../calendar/oauth";
import { sendTelegramChatAction, sendTelegramMessageWithOptions } from "./sendMessage";

function parseDateString(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function endOfDateString(value: string) {
  const date = parseDateString(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function normalizeOutboundText(value: string | null | undefined) {
  const sanitized = typeof value === "string" ? value.replace(/\0/g, "").trim() : "";
  return sanitized || "I do not have a response yet. Please try again.";
}

function isCronStatusQuestion(text: string) {
  return (
    text.includes("cron") ||
    text.includes("6 am") ||
    text.includes("6am") ||
    (text.includes("reminder") && text.includes("everyday")) ||
    (text.includes("reminder") && text.includes("every day"))
  );
}

function parseCalendarSelectionCommand(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("/usecalendar ")) {
    return {
      mode: "single" as const,
      values: [trimmed.slice("/usecalendar ".length).trim()],
    };
  }
  if (trimmed.startsWith("/usecalendars ")) {
    return {
      mode: "multiple" as const,
      values: trimmed
        .slice("/usecalendars ".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    };
  }
  return null;
}

function resolveCalendarTokens(
  tokens: string[],
  calendars: Array<{ id: string; summary: string; primary: boolean }>
) {
  const normalizedCalendars = calendars.map((calendar, index) => ({
    ...calendar,
    index: index + 1,
    summaryLower: calendar.summary.toLowerCase(),
  }));

  const resolved = new Set<string>();

  for (const token of tokens) {
    const value = token.trim().toLowerCase();
    if (!value) {
      continue;
    }

    if (value === "primary") {
      const primaryCalendar = normalizedCalendars.find((calendar) => calendar.primary);
      if (primaryCalendar) {
        resolved.add(primaryCalendar.id);
      }
      continue;
    }

    const byIndex = Number.parseInt(value, 10);
    if (!Number.isNaN(byIndex)) {
      const indexedCalendar = normalizedCalendars.find((calendar) => calendar.index === byIndex);
      if (indexedCalendar) {
        resolved.add(indexedCalendar.id);
        continue;
      }
    }

    const byId = normalizedCalendars.find((calendar) => calendar.id.toLowerCase() === value);
    if (byId) {
      resolved.add(byId.id);
      continue;
    }

    const bySummary = normalizedCalendars.find((calendar) => calendar.summaryLower === value);
    if (bySummary) {
      resolved.add(bySummary.id);
    }
  }

  return Array.from(resolved);
}

function formatCalendarListMessage(input: {
  calendars: Array<{ id: string; summary: string; primary: boolean }>;
  selectedCalendarIds: string[];
  defaultCalendarId: string;
}) {
  const lines = ["Available calendars", ""];

  input.calendars.forEach((calendar, index) => {
    const flags = [
      calendar.primary ? "primary" : "",
      input.defaultCalendarId === calendar.id ? "default" : "",
      input.selectedCalendarIds.includes(calendar.id) ? "selected" : "",
    ].filter(Boolean);
    const suffix = flags.length ? ` [${flags.join(", ")}]` : "";
    lines.push(`${index + 1}. ${calendar.summary}${suffix}`);
    lines.push(`   ${calendar.id}`);
  });

  lines.push("");
  lines.push("Use /usecalendar <number|id|primary> to set the main calendar.");
  lines.push("Use /usecalendars <item1,item2> to choose the calendars for reads and digests.");

  return lines.join("\n");
}

function defaultTelegramReplyMarkup() {
  return {
    keyboard: [
      [{ text: "/agenda" }, { text: "/today" }, { text: "/tomorrow" }],
      [{ text: "/week" }, { text: "/calendars" }, { text: "/connect" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

export const storeTelegramTurn = internalMutation({
  args: {
    ownerKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    username: v.optional(v.string()),
    inboundText: v.string(),
    outboundText: v.string(),
    correlationId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const existingConversation = await ctx.db
      .query("conversations")
      .withIndex("by_session", (query) => query.eq("sessionKey", `telegram:${args.chatId}`))
      .unique();

    const conversationId =
      existingConversation?._id ??
      (await ctx.db.insert("conversations", {
        ownerKey: args.ownerKey,
        channel: "telegram",
        externalChatId: args.chatId,
        sessionKey: `telegram:${args.chatId}`,
        status: "active",
        lastMessageAt: now,
        updatedAt: now,
      }));

    if (existingConversation) {
      await ctx.db.patch(existingConversation._id, {
        lastMessageAt: now,
        updatedAt: now,
      });
    }

    const existingAccount = await ctx.db
      .query("telegramAccounts")
      .withIndex("by_chat", (query) => query.eq("chatId", args.chatId))
      .unique();

    if (existingAccount) {
      await ctx.db.patch(existingAccount._id, {
        telegramUserId: args.userId,
        username: args.username,
        allowed: true,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("telegramAccounts", {
        ownerKey: args.ownerKey,
        telegramUserId: args.userId,
        chatId: args.chatId,
        username: args.username,
        allowed: true,
        updatedAt: now,
      });
    }

    await ctx.db.insert("messages", {
      conversationId,
      role: "user",
      text: args.inboundText,
      correlationId: args.correlationId,
      createdAt: now,
    });

    await ctx.db.insert("messages", {
      conversationId,
      role: "assistant",
      text: args.outboundText,
      correlationId: args.correlationId,
      createdAt: now,
    });

    await ctx.db.insert("runLogs", {
      ownerKey: args.ownerKey,
      correlationId: args.correlationId,
      phase: "telegram.ingest",
      status: "completed",
      summary: "Inbound Telegram message processed and reply sent",
      details: {
        chatId: args.chatId,
        userId: args.userId,
      },
      createdAt: now,
    });

    return { conversationId };
  },
});

export const ingestTelegramMessage = action({
  args: {
    chatId: v.string(),
    correlationId: v.string(),
    text: v.string(),
    userId: v.string(),
    username: v.optional(v.string()),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const env = getEnv();
    await ctx.runMutation(internal.context.workspace.ensureWorkspaceState, {
      ownerKey: env.APP_OWNER_KEY,
      displayName: args.displayName ?? args.username,
    });

    const decision = decideAction(args.text);
    let outboundText = "";
    const normalizedText = args.text.trim().toLowerCase();
    const connectUrl = `${env.CONVEX_SITE_URL}/oauth/google/start`;

    await sendTelegramChatAction(args.chatId);

    if (normalizedText === "/start") {
      const connection = await ctx.runQuery(internal.calendar.oauth.getGoogleConnection, {
        ownerKey: env.APP_OWNER_KEY,
      });
      outboundText = connection
        ? "BridgeClaw is connected and ready. Use the keyboard below or ask naturally, for example: what do I have tomorrow?"
        : `BridgeClaw is online. Connect Google Calendar here first: ${connectUrl}`;
    }

    if (normalizedText === "/connect") {
      outboundText = `Connect Google Calendar here: ${connectUrl}`;
    }

    if (!outboundText && isCronStatusQuestion(normalizedText)) {
      outboundText =
        "The daily digest cron is configured for 6:00 AM America/Bogota and runs at 11:00 UTC in Convex. The schedule is correct in code, but I have not independently verified a fired production run from logs yet.";
    }

    const promptWorkspace = await ctx.runQuery(internal.context.workspace.getPromptWorkspace, {
      ownerKey: env.APP_OWNER_KEY,
    });
    const appConfig = await ctx.runQuery(internal.calendar.oauth.getAppConfig, {
      ownerKey: env.APP_OWNER_KEY,
    });
    const connection = await ctx.runQuery(internal.calendar.oauth.getGoogleConnection, {
      ownerKey: env.APP_OWNER_KEY,
    });

    if (!outboundText && normalizedText === "/calendars") {
      const accessToken = await getValidGoogleAccessToken(ctx, env.APP_OWNER_KEY);
      if (!accessToken) {
        outboundText = `Google Calendar is not connected yet. Connect it here: ${connectUrl}`;
      } else {
        const calendars = await fetchCalendarListEntries(accessToken);
        outboundText = formatCalendarListMessage({
          calendars,
          selectedCalendarIds: appConfig?.googleCalendarSelectedIds ?? [],
          defaultCalendarId: appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID,
        });
      }
    }

    const selectionCommand = parseCalendarSelectionCommand(args.text);
    if (!outboundText && selectionCommand) {
      const accessToken = await getValidGoogleAccessToken(ctx, env.APP_OWNER_KEY);
      if (!accessToken) {
        outboundText = `Google Calendar is not connected yet. Connect it here: ${connectUrl}`;
      } else {
        const calendars = await fetchCalendarListEntries(accessToken);
        const selectedCalendarIds = resolveCalendarTokens(selectionCommand.values, calendars);

        if (selectedCalendarIds.length === 0) {
          outboundText = "I could not match that calendar selection. Use /calendars first, then pick by number, id, or primary.";
        } else {
          const defaultCalendarId = selectionCommand.mode === "single" ? selectedCalendarIds[0] : selectedCalendarIds[0];
          await ctx.runMutation(internal.calendar.oauth.setCalendarSelection, {
            ownerKey: env.APP_OWNER_KEY,
            defaultCalendarId,
            selectedCalendarIds,
          });
          const selectedNames = calendars
            .filter((calendar: { id: string; summary: string; primary: boolean }) => selectedCalendarIds.includes(calendar.id))
            .map((calendar: { id: string; summary: string; primary: boolean }) => calendar.summary);
          outboundText = `Calendar selection saved. Active calendars: ${selectedNames.join(", ")}. Default calendar: ${selectedNames[0]}.`;
        }
      }
    }

    if (!outboundText && decision.mode === "chat") {
      const prompt = composePrompt({
        appName: "BridgeClaw",
        connectionStatus: connection ? "connected" : "not connected",
        defaultCalendarId: appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID,
        selectedCalendarIds: appConfig?.googleCalendarSelectedIds ?? [],
        nowIso: new Date().toISOString(),
        timezone: appConfig?.timezone ?? env.DEFAULT_TIMEZONE,
        transcript: [],
        mode: "chat",
        message: args.text,
        agentProfile: promptWorkspace.agentProfile,
        userProfile: promptWorkspace.userProfile,
        fragments: promptWorkspace.fragments,
        topMemories: promptWorkspace.topMemories,
        todayNote: promptWorkspace.todayNote,
      });
      outboundText = normalizeOutboundText(await askGemini(prompt));
    }
    if (!outboundText && decision.mode === "read") {
      const accessToken = await getValidGoogleAccessToken(ctx, env.APP_OWNER_KEY);

      if (!accessToken) {
        outboundText = `Google Calendar is not connected yet. Connect it here: ${connectUrl}`;
      } else {
        const timeZone = appConfig?.timezone ?? env.DEFAULT_TIMEZONE;
        const locale = appConfig?.locale ?? env.DEFAULT_LOCALE;
        const selectedCalendarIds = resolveSelectedCalendarIds({
          availableCalendarIds: connection?.calendarIds ?? [],
          selectedCalendarIds: appConfig?.googleCalendarSelectedIds ?? [],
          defaultCalendarId: appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID,
        });
        const prompt = composePrompt({
          appName: "BridgeClaw",
          connectionStatus: "connected",
          defaultCalendarId: appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID,
          selectedCalendarIds,
          nowIso: new Date().toISOString(),
          timezone: timeZone,
          transcript: [],
          mode: "read",
          message: args.text,
          agentProfile: promptWorkspace.agentProfile,
          userProfile: promptWorkspace.userProfile,
          fragments: promptWorkspace.fragments,
          topMemories: promptWorkspace.topMemories,
          todayNote: promptWorkspace.todayNote,
        });

        outboundText = await runGeminiScheduleLoop({
          prompt,
          readSchedule: async ({ startDate, endDate, requestedLabel }) => {
            const events = await listAgendaRangeAcrossCalendars(
              accessToken,
              parseDateString(startDate),
              endOfDateString(endDate),
              selectedCalendarIds
            );
            return {
              calendarId: selectedCalendarIds.join(","),
              count: events.length,
              requestedLabel,
              events,
            };
          },
        });
        outboundText = normalizeOutboundText(outboundText);
      }
    }
    if (!outboundText && decision.mode === "mutate") {
      outboundText = "Mutation drafting is wired. Confirmation-gated calendar writes are the next slice.";
    }

    outboundText = normalizeOutboundText(outboundText);

    await sendTelegramMessageWithOptions(args.chatId, outboundText, {
      replyMarkup: defaultTelegramReplyMarkup(),
    });
    await ctx.runMutation(internal.telegram.ingest.storeTelegramTurn, {
      ownerKey: env.APP_OWNER_KEY,
      chatId: args.chatId,
      userId: args.userId,
      username: args.username,
      inboundText: args.text,
      outboundText,
      correlationId: args.correlationId,
    });

    return { mode: decision.mode, text: outboundText };
  },
});
