import { action, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api.js";
import { v } from "convex/values";
import { applyPendingAction } from "../assistant/applyPendingAction";
import { decideAction } from "../assistant/decide";
import { composePrompt } from "../assistant/composePrompt";
import { askGemini, runGeminiScheduleLoop } from "../ai/gemini";
import { getEnv } from "../app/env";
import { listAgendaRangeAcrossCalendars } from "../calendar/listWeekAgenda";
import { fetchCalendarListEntries, getValidGoogleAccessToken, pickWritableCalendarId, resolveSelectedCalendarIds } from "../calendar/oauth";
import { sendTelegramChatAction, sendTelegramMessageWithOptions } from "./sendMessage";

function getZonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";

  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

function formatLocalNow(date: Date, timeZone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(date);
}

function toLocalDateTimeString(parts: { year: number; month: number; day: number; hour: number; minute: number }) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:00`;
}

function addMinutesToLocalParts(parts: { year: number; month: number; day: number; hour: number; minute: number }, minutesToAdd: number) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute + minutesToAdd, 0));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: value.getUTCHours(),
    minute: value.getUTCMinutes(),
  };
}

function compareLocalParts(
  left: { year: number; month: number; day: number; hour: number; minute: number },
  right: { year: number; month: number; day: number; hour: number; minute: number }
) {
  const tupleLeft = [left.year, left.month, left.day, left.hour, left.minute];
  const tupleRight = [right.year, right.month, right.day, right.hour, right.minute];
  for (let index = 0; index < tupleLeft.length; index += 1) {
    if (tupleLeft[index] !== tupleRight[index]) {
      return tupleLeft[index] - tupleRight[index];
    }
  }
  return 0;
}

function formatEventWindow(start: string, end: string, timeZone: string, locale: string) {
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeStyle: "short",
  });
  return `${dateFormatter.format(new Date(start))} - ${timeFormatter.format(new Date(end))}`;
}

function formatFloatingEventWindow(startLocal: string, endLocal: string, locale: string) {
  const parseLocal = (value: string) => {
    const [datePart, timePart] = value.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  };

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    timeStyle: "short",
  });

  return `${dateFormatter.format(parseLocal(startLocal))} - ${timeFormatter.format(parseLocal(endLocal))}`;
}

function extractEmails(text: string) {
  return Array.from(new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []));
}

function parseCreateMeetingRequest(text: string, options: { timeZone: string; now: Date }) {
  const normalized = text.toLowerCase();
  const timeMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!timeMatch) {
    return null;
  }

  const localNow = getZonedParts(options.now, options.timeZone);
  const dayOffset = normalized.includes("tomorrow") ? 1 : 0;
  const targetDate = addMinutesToLocalParts({ ...localNow, hour: 0, minute: 0 }, dayOffset * 24 * 60);
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] ?? "0");
  const meridiem = timeMatch[3].toLowerCase();

  if (meridiem === "pm" && hour !== 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  const startParts = {
    year: targetDate.year,
    month: targetDate.month,
    day: targetDate.day,
    hour,
    minute,
  };

  if (compareLocalParts(startParts, localNow) <= 0) {
    return {
      error: "That local time has already passed in America/Bogota. Send a later time or say tomorrow.",
    } as const;
  }

  const endParts = addMinutesToLocalParts(startParts, 30);
  const emails = extractEmails(text);
  const hasVideoCall = normalized.includes("video") || normalized.includes("meet") || normalized.includes("video call");
  const summary = emails.length > 0 ? `Meeting with ${emails.join(", ")}` : "Meeting";

  return {
    actionType: "create_event" as const,
    summaryText: summary,
    draftPayload: {
      summary,
      start: {
        dateTime: toLocalDateTimeString(startParts),
        timeZone: options.timeZone,
      },
      end: {
        dateTime: toLocalDateTimeString(endParts),
        timeZone: options.timeZone,
      },
      attendees: emails.map((email) => ({ email })),
      conferenceData: hasVideoCall
        ? {
            createRequest: {
              requestId: `bridgeclaw-${options.now.getTime()}`,
            },
          }
        : undefined,
    },
  };
}

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
  calendars: Array<{ id: string; summary: string; primary: boolean; writable: boolean }>
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
  calendars: Array<{ id: string; summary: string; primary: boolean; writable: boolean }>;
  selectedCalendarIds: string[];
  defaultCalendarId: string;
}) {
  const lines = ["Available calendars", ""];

  input.calendars.forEach((calendar, index) => {
    const flags = [
      calendar.primary ? "primary" : "",
      calendar.writable ? "writable" : "read-only",
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

function formatGoogleCalendarWriteError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("403")) {
    return "Google rejected the write on the selected calendar. This usually means the current default calendar is read-only. Run /calendars, then /usecalendar primary, and try again.";
  }
  return message;
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

export const getConversationByChatId = internalQuery({
  args: {
    chatId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("conversations")
      .withIndex("by_session", (query) => query.eq("sessionKey", `telegram:${args.chatId}`))
      .unique();
  },
});

export const getPendingActionByChatId = internalQuery({
  args: {
    chatId: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session", (query) => query.eq("sessionKey", `telegram:${args.chatId}`))
      .unique();

    if (!conversation?.pendingActionId) {
      return null;
    }

    return ctx.db.get(conversation.pendingActionId);
  },
});

export const upsertPendingActionDraft = internalMutation({
  args: {
    ownerKey: v.string(),
    chatId: v.string(),
    actionType: v.union(v.literal("create_event"), v.literal("move_event"), v.literal("delete_event")),
    calendarId: v.string(),
    draftPayload: v.any(),
    summaryText: v.string(),
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

    if (existingConversation?.pendingActionId) {
      await ctx.db.patch(existingConversation.pendingActionId, {
        status: "cancelled",
      });
    }

    const pendingActionId = await ctx.db.insert("pendingActions", {
      ownerKey: args.ownerKey,
      conversationId,
      actionType: args.actionType,
      calendarId: args.calendarId,
      draftPayload: args.draftPayload,
      summaryText: args.summaryText,
      status: "draft",
      expiresAt: now + 60 * 60 * 1000,
      createdAt: now,
    });

    await ctx.db.patch(conversationId, {
      pendingActionId,
      status: "waiting_for_confirmation",
      lastMessageAt: now,
      updatedAt: now,
    });

    return pendingActionId;
  },
});

export const resolvePendingAction = internalMutation({
  args: {
    chatId: v.string(),
    nextStatus: v.union(v.literal("applied"), v.literal("cancelled"), v.literal("expired")),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session", (query) => query.eq("sessionKey", `telegram:${args.chatId}`))
      .unique();

    if (!conversation?.pendingActionId) {
      return;
    }

    await ctx.db.patch(conversation.pendingActionId, {
      status: args.nextStatus,
    });

    await ctx.db.patch(conversation._id, {
      pendingActionId: undefined,
      status: "active",
      updatedAt: Date.now(),
    });
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
    const now = new Date();

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
            .filter((calendar: { id: string; summary: string; primary: boolean; writable: boolean }) => selectedCalendarIds.includes(calendar.id))
            .map((calendar: { id: string; summary: string; primary: boolean; writable: boolean }) => calendar.summary);
          outboundText = `Calendar selection saved. Active calendars: ${selectedNames.join(", ")}. Default calendar: ${selectedNames[0]}.`;
        }
      }
    }

    if (!outboundText && decision.mode === "chat") {
      const timeZone = appConfig?.timezone ?? env.DEFAULT_TIMEZONE;
      const locale = appConfig?.locale ?? env.DEFAULT_LOCALE;
      const prompt = composePrompt({
        appName: "BridgeClaw",
        connectionStatus: connection ? "connected" : "not connected",
        defaultCalendarId: appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID,
        selectedCalendarIds: appConfig?.googleCalendarSelectedIds ?? [],
        nowIso: now.toISOString(),
        nowLocal: formatLocalNow(now, timeZone, locale),
        timezone: timeZone,
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
          nowIso: now.toISOString(),
          nowLocal: formatLocalNow(now, timeZone, locale),
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
      const accessToken = await getValidGoogleAccessToken(ctx, env.APP_OWNER_KEY);
      if (!accessToken) {
        outboundText = `Google Calendar is not connected yet. Connect it here: ${connectUrl}`;
      } else if (normalizedText === "/confirm") {
        const pendingAction = await ctx.runQuery(internal.telegram.ingest.getPendingActionByChatId, {
          chatId: args.chatId,
        });
        if (!pendingAction || pendingAction.status !== "draft") {
          outboundText = "There is no pending calendar draft to confirm.";
        } else {
          try {
            const created = await applyPendingAction(accessToken, {
              actionType: pendingAction.actionType,
              calendarId: pendingAction.calendarId,
              targetEventId: pendingAction.targetEventId,
              draftPayload: pendingAction.draftPayload,
            });
            await ctx.runMutation(internal.telegram.ingest.resolvePendingAction, {
              chatId: args.chatId,
              nextStatus: "applied",
            });
            const meetLink =
              typeof created?.hangoutLink === "string"
                ? created.hangoutLink
                : created?.conferenceData?.entryPoints?.find?.((entry: { uri?: string }) => typeof entry.uri === "string")?.uri;
            outboundText = `Event created.\n- ${created.summary}\n- ${formatEventWindow(created.start?.dateTime ?? created.start?.date, created.end?.dateTime ?? created.end?.date, appConfig?.timezone ?? env.DEFAULT_TIMEZONE, appConfig?.locale ?? env.DEFAULT_LOCALE)}${meetLink ? `\n- Meet link: ${meetLink}` : ""}`;
          } catch (error) {
            outboundText = formatGoogleCalendarWriteError(error);
            await ctx.runMutation(internal.telegram.ingest.resolvePendingAction, {
              chatId: args.chatId,
              nextStatus: "cancelled",
            });
          }
        }
      } else if (normalizedText === "/cancel") {
        await ctx.runMutation(internal.telegram.ingest.resolvePendingAction, {
          chatId: args.chatId,
          nextStatus: "cancelled",
        });
        outboundText = "Pending calendar draft cancelled.";
      } else {
        const timeZone = appConfig?.timezone ?? env.DEFAULT_TIMEZONE;
        const locale = appConfig?.locale ?? env.DEFAULT_LOCALE;
        const selectedCalendarIds = resolveSelectedCalendarIds({
          availableCalendarIds: connection?.calendarIds ?? [],
          selectedCalendarIds: appConfig?.googleCalendarSelectedIds ?? [],
          defaultCalendarId: appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID,
        });
        const draft = parseCreateMeetingRequest(args.text, {
          timeZone,
          now,
        });

        if (!draft) {
          outboundText = "I can draft a meeting when you give me a local day and time, for example: set up a meeting today at 3:30 pm with alice@example.com.";
        } else if ("error" in draft) {
          outboundText = draft.error ?? "I could not parse that local event time.";
        } else {
          const calendars = await fetchCalendarListEntries(accessToken);
          const calendarId = pickWritableCalendarId({
            calendars,
            selectedCalendarIds,
            defaultCalendarId: appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID,
          });
          if (!calendarId) {
            outboundText = "I could not find a writable Google Calendar. Run /calendars and pick a writable calendar with /usecalendar primary.";
          } else {
          await ctx.runMutation(internal.telegram.ingest.upsertPendingActionDraft, {
            ownerKey: env.APP_OWNER_KEY,
            chatId: args.chatId,
            actionType: "create_event",
            calendarId,
            draftPayload: draft.draftPayload,
            summaryText: draft.summaryText,
          });

          const startDateTime = String((draft.draftPayload.start as { dateTime: string }).dateTime);
          const endDateTime = String((draft.draftPayload.end as { dateTime: string }).dateTime);
          const attendees = (draft.draftPayload.attendees as Array<{ email: string }> | undefined) ?? [];
          const hasConferenceData = Boolean(draft.draftPayload.conferenceData);

          outboundText = [
            "Draft ready",
            `- Title: ${draft.summaryText}`,
            `- Time: ${formatFloatingEventWindow(startDateTime, endDateTime, locale)} (${timeZone})`,
            attendees.length ? `- Guests: ${attendees.map((attendee) => attendee.email).join(", ")}` : "",
            `- Video call: ${hasConferenceData ? "yes" : "no"}`,
            `- Target calendar: ${calendars.find((calendar: { id: string; summary: string; primary: boolean; writable: boolean }) => calendar.id === calendarId)?.summary ?? calendarId}`,
            "",
            "Reply /confirm to create it or /cancel to discard it.",
          ]
            .filter(Boolean)
            .join("\n");
          }
        }
      }
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
