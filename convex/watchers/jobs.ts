import { action, internalMutation, internalQuery } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { v } from "convex/values";
import { askGemini } from "../ai/gemini";
import { getEnv } from "../app/env";
import { fetchPage, searchWeb, snapshotUrl } from "../bridgecrux/client";
import { sendTelegramMessage } from "../telegram/sendMessage";

type WatchJobRecord = {
  _id: any;
  ownerKey: string;
  name: string;
  scheduleType: "weekly" | "interval";
  dayOfWeek?: string;
  intervalHours?: number;
  mode: "search" | "fetch" | "browser";
  query?: string;
  url?: string;
  instructions: string;
  deliveryChatId: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
};

function buildSourcePacket(job: WatchJobRecord, payload: unknown) {
  return JSON.stringify(
    {
      job: {
        name: job.name,
        scheduleType: job.scheduleType,
        mode: job.mode,
        instructions: job.instructions,
        query: job.query,
        url: job.url,
      },
      payload,
    },
    null,
    2
  );
}

function fallbackReport(job: WatchJobRecord, payload: any) {
  if (job.mode === "search") {
    const results = Array.isArray(payload?.results) ? payload.results.slice(0, 5) : [];
    if (results.length === 0) {
      return `Watch report: ${job.name}\n\nNo search results matched this run.`;
    }
    return [
      `Watch report: ${job.name}`,
      "",
      ...results.map((result: { title?: string; url?: string; snippet?: string }) =>
        `- ${(result.title ?? "Untitled").trim()}${result.url ? `\n  ${result.url}` : ""}${result.snippet ? `\n  ${String(result.snippet).trim()}` : ""}`
      ),
    ].join("\n");
  }

  const title = payload?.title ? `- Title: ${payload.title}` : "";
  const url = payload?.finalUrl ?? payload?.url;
  const excerptSource = payload?.excerpt ?? payload?.text ?? payload?.content ?? "";
  const excerpt = typeof excerptSource === "string" ? excerptSource.slice(0, 900).trim() : "";
  return [
    `Watch report: ${job.name}`,
    title,
    url ? `- URL: ${url}` : "",
    "",
    excerpt || "The source returned no extractable text.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function summarizeWatchPayload(job: WatchJobRecord, payload: unknown) {
  const prompt = [
    "You are BridgeClaw running a scheduled watch job for Telegram.",
    "Return final-user text only.",
    "Keep it concise, operational, and Telegram-native.",
    "Do not include hidden reasoning, self-talk, or meta commentary.",
    "If there is no meaningful change or nothing relevant, say so plainly.",
    `Watch name: ${job.name}`,
    `Mode: ${job.mode}`,
    `Instructions: ${job.instructions}`,
    "Summarize the source packet below into a useful report for the operator.",
    buildSourcePacket(job, payload),
  ].join("\n\n");

  const summary = (await askGemini(prompt)).trim();
  return summary || fallbackReport(job, payload);
}

async function executeWatch(job: WatchJobRecord) {
  if (job.mode === "search") {
    const response = await searchWeb(job.query ?? job.instructions, {
      limit: 5,
      freshness: "all",
    });
    return {
      payload: response.data,
      summary: await summarizeWatchPayload(job, response.data),
    };
  }

  if (job.mode === "fetch") {
    const response = await fetchPage(job.url ?? "", {
      format: "text",
      timeoutMs: 10000,
      maxBytes: 200000,
    });
    return {
      payload: response.data,
      summary: await summarizeWatchPayload(job, response.data),
    };
  }

  const response = await snapshotUrl(job.url ?? "", {
    includeHtml: false,
    timeoutMs: 20000,
    waitUntil: "load",
    maxBytes: 250000,
  });
  return {
    payload: response.data,
    summary: await summarizeWatchPayload(job, response.data),
  };
}

function computeNextRunAt(job: WatchJobRecord, fromTime: number) {
  if (job.scheduleType === "interval") {
    const hours = Math.max(1, job.intervalHours ?? 3);
    return fromTime + hours * 60 * 60 * 1000;
  }

  const next = new Date(Math.max(fromTime, job.nextRunAt));
  next.setUTCDate(next.getUTCDate() + 7);
  return next.getTime();
}

export const createWatchJob = internalMutation({
  args: {
    ownerKey: v.string(),
    name: v.string(),
    scheduleType: v.union(v.literal("weekly"), v.literal("interval")),
    dayOfWeek: v.optional(v.string()),
    intervalHours: v.optional(v.number()),
    mode: v.union(v.literal("search"), v.literal("fetch"), v.literal("browser")),
    query: v.optional(v.string()),
    url: v.optional(v.string()),
    instructions: v.string(),
    deliveryChatId: v.string(),
    nextRunAt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return ctx.db.insert("watchJobs", {
      ...args,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listDueWatchJobs = internalQuery({
  args: {
    now: v.number(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("watchJobs")
      .withIndex("by_next_run")
      .filter((query) => query.and(query.lte(query.field("nextRunAt"), args.now), query.eq(query.field("enabled"), true)))
      .collect();
  },
});

export const listWatchJobs = internalQuery({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("watchJobs")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .collect();
  },
});

export const completeWatchRun = internalMutation({
  args: {
    watchJobId: v.id("watchJobs"),
    summary: v.string(),
    details: v.optional(v.any()),
    finishedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.watchJobId);
    if (!job) {
      return;
    }

    await ctx.db.patch(args.watchJobId, {
      lastRunAt: args.finishedAt,
      nextRunAt: computeNextRunAt(job as WatchJobRecord, args.finishedAt),
      updatedAt: args.finishedAt,
    });

    await ctx.db.insert("watchRuns", {
      ownerKey: job.ownerKey,
      watchJobId: args.watchJobId,
      status: "completed",
      summary: args.summary,
      details: args.details,
      createdAt: args.finishedAt,
    });
  },
});

export const failWatchRun = internalMutation({
  args: {
    watchJobId: v.id("watchJobs"),
    summary: v.string(),
    details: v.optional(v.any()),
    finishedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.watchJobId);
    if (!job) {
      return;
    }

    await ctx.db.insert("watchRuns", {
      ownerKey: job.ownerKey,
      watchJobId: args.watchJobId,
      status: "failed",
      summary: args.summary,
      details: args.details,
      createdAt: args.finishedAt,
    });
  },
});

export const setHeartbeatHours = internalMutation({
  args: {
    ownerKey: v.string(),
    hours: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const config = await ctx.db
      .query("appConfig")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .unique();

    if (config) {
      await ctx.db.patch(config._id, {
        statusHeartbeatHours: args.hours,
        updatedAt: now,
      });
      return;
    }

    const env = getEnv();
    await ctx.db.insert("appConfig", {
      ownerKey: args.ownerKey,
      timezone: env.DEFAULT_TIMEZONE,
      dailyDigestHour: 6,
      dailyDigestMinute: 0,
      telegramDigestChatId: env.TELEGRAM_DEFAULT_CHAT_ID,
      statusHeartbeatHours: args.hours,
      googleCalendarDefaultId: env.GOOGLE_CALENDAR_DEFAULT_ID,
      googleCalendarSelectedIds: [env.GOOGLE_CALENDAR_DEFAULT_ID],
      locale: env.DEFAULT_LOCALE,
      updatedAt: now,
    });
  },
});

export const markHeartbeatSent = internalMutation({
  args: {
    ownerKey: v.string(),
    sentAt: v.number(),
  },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("appConfig")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .unique();

    if (config) {
      await ctx.db.patch(config._id, {
        lastStatusHeartbeatAt: args.sentAt,
        updatedAt: args.sentAt,
      });
    }
  },
});

export const runDueWatchJobs = action({
  args: {},
  handler: async (ctx) => {
    const env = getEnv();
    const dueJobs = await ctx.runQuery(internal.watchers.jobs.listDueWatchJobs, {
      now: Date.now(),
    });

    const summaries: string[] = [];

    for (const job of dueJobs as WatchJobRecord[]) {
      const finishedAt = Date.now();
      try {
        const result = await executeWatch(job);
        await sendTelegramMessage(job.deliveryChatId, result.summary);
        await ctx.runMutation(internal.watchers.jobs.completeWatchRun, {
          watchJobId: job._id,
          summary: result.summary,
          details: result.payload,
          finishedAt,
        });
        summaries.push(`${job.name}: completed`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.runMutation(internal.watchers.jobs.failWatchRun, {
          watchJobId: job._id,
          summary: message,
          details: { jobName: job.name },
          finishedAt,
        });
        await sendTelegramMessage(job.deliveryChatId, `Watch failed: ${job.name}\n\n${message}`);
        summaries.push(`${job.name}: failed`);
      }
    }

    return summaries.length > 0 ? summaries.join("\n") : `No due watch jobs for ${env.APP_OWNER_KEY}.`;
  },
});
