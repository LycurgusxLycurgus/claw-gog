import { action, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api.js";
import { v } from "convex/values";
import { decideAction } from "../assistant/decide";
import { composePrompt } from "../assistant/composePrompt";
import { askGemini } from "../ai/gemini";
import { getEnv } from "../app/env";
import { formatDigest } from "../calendar/formatDigest";
import { listAgendaRange, listWeekAgenda } from "../calendar/listWeekAgenda";
import { getValidGoogleAccessToken, pickDefaultCalendarId } from "../calendar/oauth";
import { addDays, dateKeyInZone } from "../shared/time";
import { sendTelegramMessage } from "./sendMessage";

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function parseExplicitRange(text: string, now: Date) {
  const match = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:to|through|-)\s+(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i
  );

  if (!match) {
    return null;
  }

  const startMonth = MONTHS[match[1].toLowerCase()];
  const startDay = Number(match[2]);
  const endMonth = MONTHS[(match[3] ?? match[1]).toLowerCase()];
  const endDay = Number(match[4]);
  const year = now.getFullYear();
  const start = startOfDay(new Date(year, startMonth, startDay));
  const end = endOfDay(new Date(year, endMonth, endDay));

  return {
    start,
    end,
    label: `${match[1]} ${startDay} to ${match[3] ?? match[1]} ${endDay}`,
  };
}

function parseReadWindow(text: string, now: Date) {
  const explicitRange = parseExplicitRange(text, now);
  if (explicitRange) {
    return explicitRange;
  }

  if (text.includes("today and tomorrow")) {
    return {
      start: startOfDay(now),
      end: endOfDay(addDays(now, 1)),
      label: "today and tomorrow",
    };
  }

  if (text.startsWith("/today") || text.includes("today")) {
    return {
      start: startOfDay(now),
      end: endOfDay(now),
      label: "today",
    };
  }

  if (text.startsWith("/tomorrow") || text.includes("tomorrow")) {
    const tomorrow = addDays(now, 1);
    return {
      start: startOfDay(tomorrow),
      end: endOfDay(tomorrow),
      label: "tomorrow",
    };
  }

  if (text.startsWith("/week") || text.includes("next week") || text.includes("the next week")) {
    const tomorrow = addDays(now, 1);
    return {
      start: startOfDay(tomorrow),
      end: endOfDay(addDays(tomorrow, 6)),
      label: "the next week",
    };
  }

  return {
    start: now,
    end: addDays(now, 7),
    label: "the next 7 days",
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
  },
  handler: async (ctx, args) => {
    const env = getEnv();
    const decision = decideAction(args.text);
    let outboundText = "";
    const normalizedText = args.text.trim().toLowerCase();

    if (normalizedText === "/start") {
      const connection = await ctx.runQuery(internal.calendar.oauth.getGoogleConnection, {
        ownerKey: env.APP_OWNER_KEY,
      });
      const connectUrl = `${env.CONVEX_SITE_URL}/oauth/google/start`;
      outboundText = connection
        ? "BridgeClaw is connected and ready. Try /agenda, /today, /tomorrow, or /week."
        : `BridgeClaw is online. Connect Google Calendar here first: ${connectUrl}`;
    }

    if (normalizedText === "/connect") {
      outboundText = `Connect Google Calendar here: ${env.CONVEX_SITE_URL}/oauth/google/start`;
    }

    if (!outboundText && decision.mode === "chat") {
      const prompt = composePrompt({
        nowIso: new Date().toISOString(),
        timezone: env.DEFAULT_TIMEZONE,
        transcript: [],
        message: args.text,
      });
      outboundText = await askGemini(prompt);
    }
    if (!outboundText && decision.mode === "read") {
      const appConfig = await ctx.runQuery(internal.calendar.oauth.getAppConfig, {
        ownerKey: env.APP_OWNER_KEY,
      });
      const accessToken = await getValidGoogleAccessToken(ctx, env.APP_OWNER_KEY);
      const connectUrl = `${env.CONVEX_SITE_URL}/oauth/google/start`;

      if (!accessToken) {
        outboundText = `Google Calendar is not connected yet. Connect it here: ${connectUrl}`;
      } else {
        const timeZone = appConfig?.timezone ?? env.DEFAULT_TIMEZONE;
        const locale = appConfig?.locale ?? env.DEFAULT_LOCALE;
        const connection = await ctx.runQuery(internal.calendar.oauth.getGoogleConnection, {
          ownerKey: env.APP_OWNER_KEY,
        });
        const preferredCalendarId = pickDefaultCalendarId(connection?.calendarIds ?? [], appConfig?.googleCalendarDefaultId ?? env.GOOGLE_CALENDAR_DEFAULT_ID);
        const window = parseReadWindow(normalizedText, new Date());
        let weekEvents = await listAgendaRange(accessToken, window.start, window.end, preferredCalendarId);

        if (weekEvents.length === 0 && connection?.calendarIds?.length) {
          const candidateIds = Array.from(new Set(connection.calendarIds.filter(Boolean)));
          for (const candidateId of candidateIds) {
            if (candidateId === preferredCalendarId) {
              continue;
            }
            const candidateEvents = await listAgendaRange(accessToken, window.start, window.end, candidateId);
            if (candidateEvents.length > 0) {
              weekEvents = candidateEvents;
              break;
            }
          }
        }

        outboundText =
          weekEvents.length > 0
            ? formatDigest(weekEvents, { locale, timeZone })
            : `You have no calendar events scheduled for ${window.label}.`;
      }
    }
    if (!outboundText && decision.mode === "mutate") {
      outboundText = "Mutation drafting is wired. Confirmation-gated calendar writes are the next slice.";
    }

    await sendTelegramMessage(args.chatId, outboundText);
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
