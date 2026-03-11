import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server.js";
import { getEnv } from "../app/env";

const DEFAULT_AGENT_PROFILE = {
  name: "BridgeClaw",
  creature: "calendar claw",
  vibe: "calm, precise, Telegram-native, operational",
  visibleDescription: "Telegram-first calendar assistant for one-user agenda reads, drafts, and daily 7-day digests.",
  hiddenOperatorNotes:
    "Behave like one continuous assistant. Use tools for calendar facts. Never reveal internal reasoning. Reply with final user-facing text only.",
};

const DEFAULT_CONTEXT_FRAGMENTS = [
  {
    kind: "IDENTITY" as const,
    title: "Identity",
    bodyMarkdown:
      "You are BridgeClaw, a Telegram-first calendar assistant running inside the claw-gog app. You serve one primary user and should feel like the same continuous assistant every turn.",
    priority: 100,
  },
  {
    kind: "SOUL" as const,
    title: "Tone",
    bodyMarkdown:
      "Be concise, grounded, and useful. Sound like an operator assistant, not a general chatbot. Never narrate your hidden thinking, self-talk, or tool deliberation.",
    priority: 90,
  },
  {
    kind: "AGENTS" as const,
    title: "Operational Rules",
    bodyMarkdown:
      "This app lives in Telegram. Replies must be Telegram-native: short paragraphs, hyphen bullets, no markdown tables, no nested bullets, no chain-of-thought, no meta commentary. Ask at most one follow-up question when required. Never invent events or claim writes succeeded without tool confirmation.",
    priority: 80,
  },
  {
    kind: "TOOLS" as const,
    title: "Available Tools",
    bodyMarkdown:
      "Available capabilities: read the selected Google Calendar set, send Telegram replies, send Telegram typing status, run the 6 AM daily digest, connect Google OAuth, and change the selected calendars via /calendars, /usecalendar <id|number>, or /usecalendars <id1,id2>.",
    priority: 70,
  },
  {
    kind: "FEATURE" as const,
    title: "Calendar Scope",
    bodyMarkdown:
      "Calendar reads and digests must only use the calendars explicitly selected in app config. If the selected set is empty, fall back to the configured default calendar only.",
    priority: 60,
  },
];

function buildDefaultUserProfile(displayName?: string) {
  const env = getEnv();
  const safeName = displayName?.trim() || "Codewiz";
  return {
    displayName: safeName,
    preferredName: safeName,
    timezone: env.DEFAULT_TIMEZONE,
    locale: env.DEFAULT_LOCALE,
    notes: "Primary operator and owner of the BridgeClaw calendar app.",
  };
}

export const ensureWorkspaceState = internalMutation({
  args: {
    ownerKey: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const env = getEnv();

    const agentProfile = await ctx.db
      .query("agentProfiles")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .unique();

    if (agentProfile) {
      await ctx.db.patch(agentProfile._id, {
        ...DEFAULT_AGENT_PROFILE,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("agentProfiles", {
        ownerKey: args.ownerKey,
        ...DEFAULT_AGENT_PROFILE,
        updatedAt: now,
      });
    }

    const userProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .unique();

    const defaultUserProfile = buildDefaultUserProfile(args.displayName);

    if (userProfile) {
      await ctx.db.patch(userProfile._id, {
        displayName: args.displayName?.trim() || userProfile.displayName,
        preferredName: userProfile.preferredName || defaultUserProfile.preferredName,
        timezone: userProfile.timezone || env.DEFAULT_TIMEZONE,
        locale: userProfile.locale || env.DEFAULT_LOCALE,
        notes: userProfile.notes || defaultUserProfile.notes,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("userProfiles", {
        ownerKey: args.ownerKey,
        ...defaultUserProfile,
        updatedAt: now,
      });
    }

    const appConfig = await ctx.db
      .query("appConfig")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .unique();

    if (!appConfig) {
      await ctx.db.insert("appConfig", {
        ownerKey: args.ownerKey,
        timezone: env.DEFAULT_TIMEZONE,
        dailyDigestHour: 6,
        dailyDigestMinute: 0,
        telegramDigestChatId: env.TELEGRAM_DEFAULT_CHAT_ID,
        googleCalendarDefaultId: env.GOOGLE_CALENDAR_DEFAULT_ID,
        googleCalendarSelectedIds: [env.GOOGLE_CALENDAR_DEFAULT_ID],
        locale: env.DEFAULT_LOCALE,
        updatedAt: now,
      });
    } else if (!Array.isArray(appConfig.googleCalendarSelectedIds) || appConfig.googleCalendarSelectedIds.length === 0) {
      await ctx.db.patch(appConfig._id, {
        googleCalendarSelectedIds: [appConfig.googleCalendarDefaultId || env.GOOGLE_CALENDAR_DEFAULT_ID],
        updatedAt: now,
      });
    }

    const fragmentsByKey = new Map<string, { _id: any; kind: string; title: string } & Record<string, any>>(
      (
        await Promise.all(
          ["IDENTITY", "SOUL", "AGENTS", "TOOLS", "FEATURE"].map((kind) =>
            ctx.db
              .query("contextFragments")
              .withIndex("by_scope_kind", (query) => query.eq("scope", "owner").eq("scopeId", args.ownerKey).eq("kind", kind as any))
              .collect()
          )
        )
      )
        .flat()
        .map((fragment) => [`${fragment.kind}:${fragment.title}`, fragment] as const)
    );

    for (const fragment of DEFAULT_CONTEXT_FRAGMENTS) {
      const key = `${fragment.kind}:${fragment.title}`;
      const existing = fragmentsByKey.get(key);
      if (existing) {
        await ctx.db.patch(existing._id, {
          bodyMarkdown: fragment.bodyMarkdown,
          priority: fragment.priority,
          active: true,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("contextFragments", {
          scope: "owner",
          scopeId: args.ownerKey,
          kind: fragment.kind,
          title: fragment.title,
          bodyMarkdown: fragment.bodyMarkdown,
          priority: fragment.priority,
          active: true,
          updatedAt: now,
        });
      }
    }
  },
});

export const getPromptWorkspace = internalQuery({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    const [agentProfile, userProfile, memories, todayNote, fragmentGroups] = await Promise.all([
      ctx.db.query("agentProfiles").withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey)).unique(),
      ctx.db.query("userProfiles").withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey)).unique(),
      ctx.db.query("memoryEntries").withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey)).collect(),
      ctx.db
        .query("dailyNotes")
        .withIndex("by_owner_date", (query) => query.eq("ownerKey", args.ownerKey).eq("noteDate", new Date().toISOString().slice(0, 10)))
        .unique(),
      Promise.all(
        ["IDENTITY", "SOUL", "AGENTS", "TOOLS", "FEATURE", "USER", "MEMORY", "POLICY", "BOOTSTRAP"].map((kind) =>
          ctx.db
            .query("contextFragments")
            .withIndex("by_scope_kind", (query) => query.eq("scope", "owner").eq("scopeId", args.ownerKey).eq("kind", kind as any))
            .collect()
        )
      ),
    ]);

    const fragments = fragmentGroups
      .flat()
      .filter((fragment) => fragment.active)
      .sort((left, right) => right.priority - left.priority)
      .map((fragment) => ({
        kind: fragment.kind,
        title: fragment.title,
        bodyMarkdown: fragment.bodyMarkdown,
      }));

    const topMemories = memories
      .sort((left, right) => right.salience - left.salience || right.updatedAt - left.updatedAt)
      .slice(0, 6)
      .map((entry) => entry.body);

    return {
      agentProfile,
      userProfile,
      fragments,
      topMemories,
      todayNote: todayNote?.body ?? "",
    };
  },
});

export const upsertDailyNote = internalMutation({
  args: {
    ownerKey: v.string(),
    noteDate: v.string(),
    body: v.string(),
    generatedBy: v.union(v.literal("assistant"), v.literal("operator"), v.literal("system")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("dailyNotes")
      .withIndex("by_owner_date", (query) => query.eq("ownerKey", args.ownerKey).eq("noteDate", args.noteDate))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        body: args.body,
        generatedBy: args.generatedBy,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("dailyNotes", {
        ...args,
        updatedAt: Date.now(),
      });
    }
  },
});
