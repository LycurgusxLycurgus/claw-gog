import { action, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api.js";
import { v } from "convex/values";
import { applyPendingAction } from "../assistant/applyPendingAction";
import { decideAction } from "../assistant/decide";
import { composePrompt } from "../assistant/composePrompt";
import { askGemini, runGeminiScheduleLoop } from "../ai/gemini";
import { getEnv } from "../app/env";
import { fetchPage, searchWeb, snapshotUrl } from "../bridgecrux/client";
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

function localPartsToUtcTimestamp(parts: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string) {
  const targetAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const zonedAtGuess = getZonedParts(new Date(targetAsUtc), timeZone);
  const zonedAsUtc = Date.UTC(zonedAtGuess.year, zonedAtGuess.month - 1, zonedAtGuess.day, zonedAtGuess.hour, zonedAtGuess.minute, 0);
  return targetAsUtc - (zonedAsUtc - targetAsUtc);
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

function daysUntilWeekday(currentWeekday: number, targetWeekday: number, forceNext: boolean) {
  let diff = (targetWeekday - currentWeekday + 7) % 7;
  if (diff === 0 && forceNext) {
    diff = 7;
  }
  return diff;
}

function resolveRequestedDateParts(text: string, localNow: { year: number; month: number; day: number; hour: number; minute: number }) {
  const normalized = text.toLowerCase();
  if (normalized.includes("today")) {
    return { year: localNow.year, month: localNow.month, day: localNow.day };
  }
  if (normalized.includes("tomorrow")) {
    const tomorrow = addMinutesToLocalParts({ ...localNow, hour: 0, minute: 0 }, 24 * 60);
    return { year: tomorrow.year, month: tomorrow.month, day: tomorrow.day };
  }

  const weekdayMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const weekdayMatch = normalized.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekdayMatch) {
    const currentWeekday = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day)).getUTCDay();
    const targetWeekday = weekdayMap[weekdayMatch[2]];
    const diffDays = daysUntilWeekday(currentWeekday, targetWeekday, Boolean(weekdayMatch[1]));
    const result = addMinutesToLocalParts({ ...localNow, hour: 0, minute: 0 }, diffDays * 24 * 60);
    return { year: result.year, month: result.month, day: result.day };
  }

  const monthMap: Record<string, number> = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };

  const monthDayMatch = normalized.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/
  );
  if (monthDayMatch) {
    return {
      year: Number(monthDayMatch[3] ?? localNow.year),
      month: monthMap[monthDayMatch[1]],
      day: Number(monthDayMatch[2]),
    };
  }

  const dayMonthMatch = normalized.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:,?\s*(\d{4}))?\b/
  );
  if (dayMonthMatch) {
    return {
      year: Number(dayMonthMatch[3] ?? localNow.year),
      month: monthMap[dayMonthMatch[2]],
      day: Number(dayMonthMatch[1]),
    };
  }

  const numericMatch = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numericMatch) {
    const rawYear = numericMatch[3];
    const year = rawYear ? (rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear)) : localNow.year;
    return {
      year,
      month: Number(numericMatch[1]),
      day: Number(numericMatch[2]),
    };
  }

  return { year: localNow.year, month: localNow.month, day: localNow.day };
}

function hasExplicitDateReference(text: string) {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("today") ||
    normalized.includes("tomorrow") ||
    /\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.test(normalized) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/.test(normalized) ||
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(normalized) ||
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(normalized)
  );
}

function parseCreateMeetingRequest(text: string, options: { timeZone: string; now: Date }) {
  const normalized = text.toLowerCase();
  const timeMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!timeMatch) {
    return null;
  }

  const localNow = getZonedParts(options.now, options.timeZone);
  const targetDate = resolveRequestedDateParts(text, localNow);
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

function parseDeleteOrMoveRequest(text: string) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith("delete ")) {
    return {
      actionType: "delete_event" as const,
      subject: trimmed.slice(7).trim(),
    };
  }

  if (lower.startsWith("remove ")) {
    return {
      actionType: "delete_event" as const,
      subject: trimmed.slice(7).trim(),
    };
  }

  const moveMatch = trimmed.match(/^(?:move|reschedule)\s+(.+?)\s+to\s+(.+)$/i);
  if (moveMatch) {
    return {
      actionType: "move_event" as const,
      subject: moveMatch[1].trim(),
      targetExpression: moveMatch[2].trim(),
    };
  }

  return null;
}

function extractEventSearchQuery(subject: string) {
  return subject
    .replace(/\b(today|tomorrow|next|on|at|from|to)\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\s*(am|pm)\b/gi, " ")
    .replace(/\b\d{1,2}\s*(am|pm)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreEventMatch(summary: string, query: string) {
  const normalizedSummary = summary.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (normalizedSummary === normalizedQuery) {
    return 100;
  }
  if (normalizedSummary.startsWith(normalizedQuery)) {
    return 80;
  }
  if (normalizedSummary.includes(normalizedQuery)) {
    return 60;
  }
  return 0;
}

function matchesLocalDate(dateLike: string, target: { year: number; month: number; day: number }, timeZone: string) {
  const parts = getZonedParts(new Date(dateLike), timeZone);
  return parts.year === target.year && parts.month === target.month && parts.day === target.day;
}

async function findMatchingEvent(input: {
  accessToken: string;
  calendarIds: string[];
  query: string;
  timeZone: string;
  now: Date;
  requestedDateText?: string;
}) {
  const searchEnd = new Date(input.now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const results = await Promise.all(
    input.calendarIds.map(async (calendarId) => {
      const events = await listAgendaRangeAcrossCalendars(input.accessToken, input.now, searchEnd, [calendarId]);
      return events.map((event) => ({ ...event, calendarId }));
    })
  );

  const allEvents = results.flat();
  const explicitDate = input.requestedDateText && hasExplicitDateReference(input.requestedDateText)
    ? resolveRequestedDateParts(input.requestedDateText, getZonedParts(input.now, input.timeZone))
    : null;

  const ranked = allEvents
    .map((event) => ({
      event,
      score:
        scoreEventMatch(event.summary, input.query) +
        (explicitDate && matchesLocalDate(event.start, explicitDate, input.timeZone) ? 25 : 0),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || new Date(left.event.start).getTime() - new Date(right.event.start).getTime());

  return ranked[0]?.event ?? null;
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

function truncateText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
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

function parseHeartbeatIntervalRequest(text: string) {
  const match = text.trim().toLowerCase().match(/(?:set|make|change|update)\s+(?:the\s+)?heartbeat(?:\s+status)?(?:\s+to)?\s+every\s+(\d+)\s+hours?/i);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) {
    return null;
  }
  return Math.min(24, Math.max(1, hours));
}

function parseRememberRequest(text: string) {
  const trimmed = text.trim();
  const rememberMatch = trimmed.match(/^(?:remember|please remember)\s+(?:that\s+)?(.+)$/i);
  const dontForgetMatch = trimmed.match(/^(?:don't forget|do not forget)\s+(?:that\s+)?(.+)$/i);
  const body = (rememberMatch?.[1] ?? dontForgetMatch?.[1] ?? "").trim();
  if (!body) {
    return null;
  }
  const lowerBody = body.toLowerCase();
  const memoryType =
    lowerBody.includes("prefer") || lowerBody.includes("i like") || lowerBody.includes("my favorite")
      ? "preference"
      : lowerBody.includes("workflow") || lowerBody.includes("always") || lowerBody.includes("when ")
        ? "workflow"
        : lowerBody.includes("warning") || lowerBody.includes("avoid") || lowerBody.includes("never")
          ? "warning"
          : "fact";

  return {
    body: body.replace(/[.]+$/, ""),
    memoryType,
  } as const;
}

function parseDirectToolRequest(text: string) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (/\bevery\s+\d+\s+hours?\b/i.test(trimmed) || /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(trimmed)) {
    return null;
  }
  const urlMatch = trimmed.match(/https?:\/\/\S+/i);
  const url = urlMatch?.[0];

  if (url && /(?:browse|open|render|snapshot|inspect in browser)/i.test(trimmed)) {
    return {
      mode: "browser" as const,
      url,
      instructions: trimmed,
    };
  }

  if (url && /(?:fetch|read|check|inspect|review|summarize)/i.test(trimmed)) {
    return {
      mode: "fetch" as const,
      url,
      instructions: trimmed,
    };
  }

  const searchMatch =
    trimmed.match(/^(?:search(?: the web)? for|look up|look for|find)\s+(.+)$/i) ??
    trimmed.match(/^(?:can you )?(?:search|look up|find)\s+(.+)$/i);

  if (searchMatch) {
    return {
      mode: "search" as const,
      query: searchMatch[1].trim(),
      instructions: trimmed,
    };
  }

  return null;
}

function weekdayIndex(name: string) {
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(name.toLowerCase());
}

function deriveWatchName(input: { mode: "search" | "fetch" | "browser"; query?: string; url?: string }) {
  if (input.mode === "search") {
    return truncateText(`Search: ${input.query ?? "watch"}`, 70);
  }

  try {
    const hostname = input.url ? new URL(input.url).hostname : "page";
    return truncateText(`${input.mode === "browser" ? "Browser" : "Page"}: ${hostname}`, 70);
  } catch {
    return truncateText(`${input.mode === "browser" ? "Browser" : "Page"} watch`, 70);
  }
}

function parseWatchJobRequest(text: string, options: { timeZone: string; now: Date; chatId: string }) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const intervalMatch = lower.match(/\bevery\s+(\d+)\s+hours?\b/);
  const weeklyMatch = lower.match(
    /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b/
  );

  if (!intervalMatch && !weeklyMatch) {
    return null;
  }

  const toolRequest = parseDirectToolRequest(trimmed) ??
    (() => {
      const urlMatch = trimmed.match(/https?:\/\/\S+/i);
      if (urlMatch) {
        return {
          mode: "fetch" as const,
          url: urlMatch[0],
          instructions: trimmed,
        };
      }
      const cleaned = trimmed
        .replace(/\bevery\s+\d+\s+hours?\b/i, "")
        .replace(/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i, "")
        .replace(/^(?:set up|create|make)\s+(?:a\s+)?(?:cron job|automation|watch|reminder)\s+(?:to\s+)?/i, "")
        .trim();

      if (!cleaned) {
        return null;
      }

      return {
        mode: "search" as const,
        query: cleaned,
        instructions: trimmed,
      };
    })();

  if (!toolRequest) {
    return null;
  }

  let nextRunAt = 0;
  let scheduleType: "weekly" | "interval";
  let dayOfWeek: string | undefined;
  let intervalHours: number | undefined;

  if (intervalMatch) {
    intervalHours = Math.max(1, Number(intervalMatch[1]));
    scheduleType = "interval";
    nextRunAt = options.now.getTime() + intervalHours * 60 * 60 * 1000;
  } else {
    scheduleType = "weekly";
    dayOfWeek = weeklyMatch?.[1].toLowerCase();
    const localNow = getZonedParts(options.now, options.timeZone);
    const currentWeekday = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day)).getUTCDay();
    const targetWeekday = weekdayIndex(dayOfWeek ?? "saturday");
    const baseDate = addMinutesToLocalParts({ ...localNow, hour: 0, minute: 0 }, daysUntilWeekday(currentWeekday, targetWeekday, false) * 24 * 60);

    let hour = Number(weeklyMatch?.[2] ?? "9");
    const minute = Number(weeklyMatch?.[3] ?? "0");
    const meridiem = weeklyMatch?.[4]?.toLowerCase();

    if (meridiem === "pm" && hour !== 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }

    const runParts = {
      year: baseDate.year,
      month: baseDate.month,
      day: baseDate.day,
      hour,
      minute,
    };

    nextRunAt = localPartsToUtcTimestamp(runParts, options.timeZone);
    if (nextRunAt <= options.now.getTime()) {
      const nextWeek = addMinutesToLocalParts(runParts, 7 * 24 * 60);
      nextRunAt = localPartsToUtcTimestamp(nextWeek, options.timeZone);
    }
  }

  return {
    actionType: "create_watch_job" as const,
    summaryText: `Create watch job: ${deriveWatchName(toolRequest)}`,
    draftPayload: {
      name: deriveWatchName(toolRequest),
      scheduleType,
      dayOfWeek,
      intervalHours,
      mode: toolRequest.mode,
      query: "query" in toolRequest ? toolRequest.query : undefined,
      url: "url" in toolRequest ? toolRequest.url : undefined,
      instructions: toolRequest.instructions,
      deliveryChatId: options.chatId,
      nextRunAt,
    },
  };
}

function formatWatchDraftMessage(draftPayload: {
  name: string;
  scheduleType: "weekly" | "interval";
  dayOfWeek?: string;
  intervalHours?: number;
  mode: "search" | "fetch" | "browser";
  query?: string;
  url?: string;
  instructions: string;
  nextRunAt: number;
}, locale: string, timeZone: string) {
  const scheduleLabel =
    draftPayload.scheduleType === "interval"
      ? `every ${draftPayload.intervalHours} hour(s)`
      : `every ${draftPayload.dayOfWeek}`;

  const nextRunLabel = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(draftPayload.nextRunAt));

  return [
    "Draft ready",
    `- Action: create automation`,
    `- Name: ${draftPayload.name}`,
    `- Schedule: ${scheduleLabel}`,
    `- Mode: ${draftPayload.mode}`,
    draftPayload.query ? `- Query: ${draftPayload.query}` : "",
    draftPayload.url ? `- URL: ${draftPayload.url}` : "",
    `- Next run: ${nextRunLabel} (${timeZone})`,
    "",
    "Reply /confirm to create it or /cancel to discard it.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatWatchListMessage(watchJobs: Array<{
  name: string;
  enabled: boolean;
  scheduleType: "weekly" | "interval";
  dayOfWeek?: string;
  intervalHours?: number;
  mode: "search" | "fetch" | "browser";
  nextRunAt: number;
}>, locale: string, timeZone: string) {
  if (watchJobs.length === 0) {
    return "No recurring watch jobs are configured yet.";
  }

  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });

  return [
    "Active watch jobs",
    "",
    ...watchJobs.map((job, index) => {
      const schedule = job.scheduleType === "interval" ? `every ${job.intervalHours}h` : `every ${job.dayOfWeek}`;
      return `${index + 1}. ${job.name}\n- ${job.mode}\n- ${schedule}\n- next: ${formatter.format(new Date(job.nextRunAt))}\n- ${job.enabled ? "enabled" : "disabled"}`;
    }),
  ].join("\n");
}

async function summarizeDirectToolResult(input: {
  mode: "search" | "fetch" | "browser";
  instructions: string;
  payload: unknown;
}) {
  const prompt = [
    "You are BridgeClaw replying in Telegram.",
    "Return final-user text only.",
    "Summarize the tool result concisely and operationally.",
    "No chain-of-thought, no self-talk, no markdown tables.",
    `Mode: ${input.mode}`,
    `User request: ${input.instructions}`,
    JSON.stringify(input.payload, null, 2),
  ].join("\n\n");

  const summary = (await askGemini(prompt)).trim();
  if (summary) {
    return summary;
  }

  if (input.mode === "search") {
    const results = Array.isArray((input.payload as { results?: unknown[] })?.results)
      ? ((input.payload as { results?: Array<{ title?: string; url?: string }> }).results ?? [])
      : [];
    return results.length > 0
      ? [
          "Search results",
          "",
          ...results.slice(0, 5).map((result) => `- ${result.title ?? "Untitled"}${result.url ? `\n  ${result.url}` : ""}`),
        ].join("\n")
      : "No search results matched that request.";
  }

  const payload = input.payload as { title?: string; finalUrl?: string; url?: string; excerpt?: string; text?: string; content?: string };
  return [
    payload.title ? `Title: ${payload.title}` : "No title found.",
    payload.finalUrl ?? payload.url ?? "",
    "",
    truncateText(String(payload.excerpt ?? payload.text ?? payload.content ?? "No extractable text."), 1200),
  ]
    .filter(Boolean)
    .join("\n");
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
      [{ text: "/week" }, { text: "/calendars" }, { text: "/watches" }],
      [{ text: "/connect" }],
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
    actionType: v.union(v.literal("create_event"), v.literal("move_event"), v.literal("delete_event"), v.literal("create_watch_job")),
    calendarId: v.string(),
    targetEventId: v.optional(v.string()),
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
      targetEventId: args.targetEventId,
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
        ? "BridgeClaw is connected and ready. Use the keyboard below or ask naturally. I can read and update your calendar, run recurring watches, and search or inspect the web through BridgeCrux."
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

    if (!outboundText && normalizedText === "/watches") {
      const watchJobs = await ctx.runQuery(internal.watchers.jobs.listWatchJobs, {
        ownerKey: env.APP_OWNER_KEY,
      });
      outboundText = formatWatchListMessage(
        watchJobs.sort((left: { nextRunAt: number }, right: { nextRunAt: number }) => left.nextRunAt - right.nextRunAt),
        appConfig?.locale ?? env.DEFAULT_LOCALE,
        appConfig?.timezone ?? env.DEFAULT_TIMEZONE
      );
    }

    const heartbeatHours = parseHeartbeatIntervalRequest(args.text);
    if (!outboundText && heartbeatHours) {
      await ctx.runMutation(internal.watchers.jobs.setHeartbeatHours, {
        ownerKey: env.APP_OWNER_KEY,
        hours: heartbeatHours,
      });
      outboundText = `Heartbeat interval saved. BridgeClaw will send status updates every ${heartbeatHours} hour(s).`;
    }

    const rememberRequest = parseRememberRequest(args.text);
    if (!outboundText && rememberRequest) {
      await ctx.runMutation(internal.context.workspace.rememberMemory, {
        ownerKey: env.APP_OWNER_KEY,
        body: rememberRequest.body,
        memoryType: rememberRequest.memoryType,
        tags: ["telegram", "operator"],
        salience: 85,
      });
      outboundText = `Saved to memory: ${rememberRequest.body}`;
    }

    const directToolRequest = parseDirectToolRequest(args.text);
    if (!outboundText && directToolRequest) {
      if (directToolRequest.mode === "search") {
        const response = await searchWeb(directToolRequest.query, {
          limit: 5,
          freshness: "all",
        });
        outboundText = await summarizeDirectToolResult({
          mode: "search",
          instructions: directToolRequest.instructions,
          payload: response.data,
        });
      } else if (directToolRequest.mode === "fetch") {
        const response = await fetchPage(directToolRequest.url, {
          format: "text",
          timeoutMs: 10000,
          maxBytes: 200000,
        });
        outboundText = await summarizeDirectToolResult({
          mode: "fetch",
          instructions: directToolRequest.instructions,
          payload: response.data,
        });
      } else {
        const response = await snapshotUrl(directToolRequest.url, {
          includeHtml: false,
          timeoutMs: 20000,
          waitUntil: "load",
          maxBytes: 250000,
        });
        outboundText = await summarizeDirectToolResult({
          mode: "browser",
          instructions: directToolRequest.instructions,
          payload: response.data,
        });
      }
    }

    const watchDraft = parseWatchJobRequest(args.text, {
      timeZone: appConfig?.timezone ?? env.DEFAULT_TIMEZONE,
      now,
      chatId: args.chatId,
    });
    if (!outboundText && watchDraft) {
      await ctx.runMutation(internal.telegram.ingest.upsertPendingActionDraft, {
        ownerKey: env.APP_OWNER_KEY,
        chatId: args.chatId,
        actionType: "create_watch_job",
        calendarId: "automation",
        targetEventId: undefined,
        draftPayload: watchDraft.draftPayload,
        summaryText: watchDraft.summaryText,
      });
      outboundText = formatWatchDraftMessage(
        watchDraft.draftPayload,
        appConfig?.locale ?? env.DEFAULT_LOCALE,
        appConfig?.timezone ?? env.DEFAULT_TIMEZONE
      );
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
      if (normalizedText === "/confirm") {
        const pendingAction = await ctx.runQuery(internal.telegram.ingest.getPendingActionByChatId, {
          chatId: args.chatId,
        });
        if (!pendingAction || pendingAction.status !== "draft") {
          outboundText = "There is no pending draft to confirm.";
        } else {
          if (pendingAction.actionType === "create_watch_job") {
            const payload = pendingAction.draftPayload as {
              name: string;
              scheduleType: "weekly" | "interval";
              dayOfWeek?: string;
              intervalHours?: number;
              mode: "search" | "fetch" | "browser";
              query?: string;
              url?: string;
              instructions: string;
              deliveryChatId: string;
              nextRunAt: number;
            };
            await ctx.runMutation(internal.watchers.jobs.createWatchJob, {
              ownerKey: env.APP_OWNER_KEY,
              name: payload.name,
              scheduleType: payload.scheduleType,
              dayOfWeek: payload.dayOfWeek,
              intervalHours: payload.intervalHours,
              mode: payload.mode,
              query: payload.query,
              url: payload.url,
              instructions: payload.instructions,
              deliveryChatId: payload.deliveryChatId,
              nextRunAt: payload.nextRunAt,
            });
            await ctx.runMutation(internal.telegram.ingest.resolvePendingAction, {
              chatId: args.chatId,
              nextStatus: "applied",
            });
            outboundText = `Automation created.\n- ${payload.name}\n- Next run: ${new Intl.DateTimeFormat(appConfig?.locale ?? env.DEFAULT_LOCALE, {
              timeZone: appConfig?.timezone ?? env.DEFAULT_TIMEZONE,
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(payload.nextRunAt))}`;
          } else {
            try {
              const accessToken = await getValidGoogleAccessToken(ctx, env.APP_OWNER_KEY);
              if (!accessToken) {
                outboundText = `Google Calendar is not connected yet. Connect it here: ${connectUrl}`;
                throw new Error("calendar auth missing");
              }
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
              if (!outboundText) {
                outboundText = formatGoogleCalendarWriteError(error);
              }
              if (outboundText !== `Google Calendar is not connected yet. Connect it here: ${connectUrl}`) {
                await ctx.runMutation(internal.telegram.ingest.resolvePendingAction, {
                  chatId: args.chatId,
                  nextStatus: "cancelled",
                });
              }
            }
          }
        }
      } else if (normalizedText === "/cancel") {
        await ctx.runMutation(internal.telegram.ingest.resolvePendingAction, {
          chatId: args.chatId,
          nextStatus: "cancelled",
        });
        outboundText = "Pending draft cancelled.";
      } else {
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
        const draft = parseCreateMeetingRequest(args.text, {
          timeZone,
          now,
        });
        const mutationRequest = parseDeleteOrMoveRequest(args.text);

        if (mutationRequest?.actionType === "delete_event") {
          const query = extractEventSearchQuery(mutationRequest.subject);
          const matchedEvent = await findMatchingEvent({
            accessToken,
            calendarIds: selectedCalendarIds,
            query,
            timeZone,
            now,
            requestedDateText: mutationRequest.subject,
          });

          if (!matchedEvent) {
            outboundText = `I could not find an upcoming event matching "${query}". Try the event title and, if needed, the date.`;
          } else {
            await ctx.runMutation(internal.telegram.ingest.upsertPendingActionDraft, {
              ownerKey: env.APP_OWNER_KEY,
              chatId: args.chatId,
              actionType: "delete_event",
              calendarId: matchedEvent.calendarId,
              targetEventId: matchedEvent.id,
              draftPayload: {},
              summaryText: `Delete ${matchedEvent.summary}`,
            });

            outboundText = [
              "Draft ready",
              `- Action: delete`,
              `- Event: ${matchedEvent.summary}`,
              `- Time: ${formatEventWindow(matchedEvent.start, matchedEvent.end ?? matchedEvent.start, timeZone, locale)}`,
              "",
              "Reply /confirm to delete it or /cancel to discard it.",
            ].join("\n");
          }
        } else if (mutationRequest?.actionType === "move_event") {
          const query = extractEventSearchQuery(mutationRequest.subject);
          const matchedEvent = await findMatchingEvent({
            accessToken,
            calendarIds: selectedCalendarIds,
            query,
            timeZone,
            now,
            requestedDateText: mutationRequest.subject,
          });
          const moveDraft = mutationRequest.targetExpression
            ? parseCreateMeetingRequest(`set up ${matchedEvent?.summary ?? "meeting"} on ${mutationRequest.targetExpression}`, {
                timeZone,
                now,
              })
            : null;

          if (!matchedEvent) {
            outboundText = `I could not find an upcoming event matching "${query}". Try the event title and, if needed, the date.`;
          } else if (!moveDraft || "error" in moveDraft) {
            outboundText =
              typeof moveDraft === "object" && moveDraft && "error" in moveDraft
                ? moveDraft.error ?? "I could not parse the new local time."
                : "I could not parse the new date and time. Try something like: move archID to friday at 2 pm.";
          } else {
            const updatedPayload = {
              summary: matchedEvent.summary,
              start: moveDraft.draftPayload.start,
              end: moveDraft.draftPayload.end,
            };

            await ctx.runMutation(internal.telegram.ingest.upsertPendingActionDraft, {
              ownerKey: env.APP_OWNER_KEY,
              chatId: args.chatId,
              actionType: "move_event",
              calendarId: matchedEvent.calendarId,
              targetEventId: matchedEvent.id,
              draftPayload: updatedPayload,
              summaryText: `Move ${matchedEvent.summary}`,
            });

            outboundText = [
              "Draft ready",
              `- Action: move`,
              `- Event: ${matchedEvent.summary}`,
              `- From: ${formatEventWindow(matchedEvent.start, matchedEvent.end ?? matchedEvent.start, timeZone, locale)}`,
              `- To: ${formatFloatingEventWindow(String((updatedPayload.start as { dateTime: string }).dateTime), String((updatedPayload.end as { dateTime: string }).dateTime), locale)} (${timeZone})`,
              "",
              "Reply /confirm to move it or /cancel to discard it.",
            ].join("\n");
          }
        } else if (!draft) {
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
            targetEventId: undefined,
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
