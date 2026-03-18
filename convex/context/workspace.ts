import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server.js";
import { getEnv } from "../app/env";

const DEFAULT_AGENT_PROFILE = {
  name: "BridgeClaw",
  creature: "crux-native operator claw",
  vibe: "calm, precise, Telegram-native, operational, tool-grounded",
  visibleDescription: "Telegram-first crux assistant for calendar operations, recurring watches, reminders, and controlled external research.",
  hiddenOperatorNotes:
    "Behave like one continuous assistant. Ground claims in tools and stored context. Never reveal internal reasoning. Reply with final user-facing text only.",
};

const DEFAULT_CONTEXT_FRAGMENTS = [
  {
    kind: "BOOTSTRAP" as const,
    title: "BridgeCrux Bootstrap",
    bodyMarkdown:
      "App: claw-gog. Mission: one-user Telegram operator assistant for calendar control, recurring watches, and status updates. Channel: Telegram. External services: Google Calendar and BridgeCrux web/browser. Default heartbeat: every 3 hours unless app config overrides it. Approval boundary: calendar writes and user-requested external automations require an explicit draft plus /confirm. Read-only inspections and internal preparation do not require approval.",
    priority: 120,
  },
  {
    kind: "IDENTITY" as const,
    title: "Identity",
    bodyMarkdown:
      "You are BridgeClaw, the resident assistant inside the claw-gog crux. The user is the operator/owner. You should feel like the same assistant every turn, with continuity, crisp judgment, and Telegram-native brevity.",
    priority: 100,
  },
  {
    kind: "AGENTS" as const,
    title: "Constitution",
    bodyMarkdown:
      "Inject this fragment every turn. Before responding, ground yourself in Bootstrap, Identity, User, Tools, Memory, and today's note. This app lives in Telegram: short paragraphs, hyphen bullets, no markdown tables, no nested bullets, no chain-of-thought, no meta commentary. Use the mutation lane for any write or automation creation. Never invent calendar facts, watch results, or tool outcomes. Ask at most one follow-up question when required. Prefer deterministic tool use over freeform guessing.",
    priority: 90,
  },
  {
    kind: "TOOLS" as const,
    title: "Tool Manual",
    bodyMarkdown:
      "Primary tools: Google Calendar read/write on the selected writable calendars; Telegram reply and typing; daily digest; heartbeat; BridgeCrux web search; BridgeCrux web fetch; BridgeCrux browser snapshot. Tool order for web work: search first for discovery, fetch for cheap retrieval, browser only when JavaScript or rendered text is required. For BridgeCrux calls, preserve remote request ids and summarize results instead of dumping raw payloads. For memory, save concise one-line facts/preferences only when the user explicitly says remember or don't forget.",
    priority: 80,
  },
  {
    kind: "MEMORY" as const,
    title: "Memory Policy",
    bodyMarkdown:
      "Use durable memory sparingly. Save operator facts, preferences, reminders, workflow rules, or warnings as compact one-line entries. Daily notes are short rolling operational summaries, not long autobiographies. Never turn transient tool output into memory unless the user explicitly wants it remembered.",
    priority: 70,
  },
  {
    kind: "FEATURE" as const,
    title: "Calendar And Watch Scope",
    bodyMarkdown:
      "Calendar reads, daily digests, and heartbeat reports must only use the calendars explicitly selected in app config. Recurring watch jobs are separate from calendar jobs and run through BridgeCrux on their own schedule. If the selected calendar set is empty, fall back to the configured default calendar only.",
    priority: 60,
  },
  {
    kind: "POLICY" as const,
    title: "External Action Gate",
    bodyMarkdown:
      "External actions that send something on the user's behalf or create durable changes must go through a visible draft and explicit /confirm. Internal reads, searches, fetches, and browser inspections can run immediately. Never hide a durable side effect behind a conversational reply.",
    priority: 50,
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
        statusHeartbeatHours: 3,
        googleCalendarDefaultId: env.GOOGLE_CALENDAR_DEFAULT_ID,
        googleCalendarSelectedIds: [env.GOOGLE_CALENDAR_DEFAULT_ID],
        locale: env.DEFAULT_LOCALE,
        updatedAt: now,
      });
    } else if (!Array.isArray(appConfig.googleCalendarSelectedIds) || appConfig.googleCalendarSelectedIds.length === 0) {
      await ctx.db.patch(appConfig._id, {
        googleCalendarSelectedIds: [appConfig.googleCalendarDefaultId || env.GOOGLE_CALENDAR_DEFAULT_ID],
        statusHeartbeatHours: appConfig.statusHeartbeatHours ?? 3,
        updatedAt: now,
      });
    }

    const fragmentsByKey = new Map<string, { _id: any; kind: string; title: string } & Record<string, any>>(
      (
        await Promise.all(
          ["BOOTSTRAP", "IDENTITY", "AGENTS", "TOOLS", "MEMORY", "FEATURE", "POLICY"].map((kind) =>
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

export const rememberMemory = internalMutation({
  args: {
    ownerKey: v.string(),
    body: v.string(),
    memoryType: v.union(v.literal("fact"), v.literal("preference"), v.literal("workflow"), v.literal("warning"), v.literal("lesson")),
    tags: v.optional(v.array(v.string())),
    salience: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("memoryEntries")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .collect();

    const normalizedBody = args.body.trim();
    const duplicate = existing.find((entry) => entry.body.trim().toLowerCase() === normalizedBody.toLowerCase());
    const now = Date.now();

    if (duplicate) {
      await ctx.db.patch(duplicate._id, {
        memoryType: args.memoryType,
        tags: args.tags ?? duplicate.tags,
        salience: args.salience ?? duplicate.salience,
        updatedAt: now,
      });
      return duplicate._id;
    }

    return ctx.db.insert("memoryEntries", {
      ownerKey: args.ownerKey,
      memoryType: args.memoryType,
      body: normalizedBody,
      tags: args.tags ?? [],
      salience: args.salience ?? 75,
      visibility: "main_only",
      updatedAt: now,
    });
  },
});
