import { v } from "convex/values";
import { getEnv } from "../app/env";
import { internal } from "../_generated/api.js";
import { internalMutation, internalQuery } from "../_generated/server.js";

const GOOGLE_OAUTH_SCOPE = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export function buildGoogleOauthUrl(state: string) {
  const env = getEnv();
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    prompt: "consent",
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPE.join(" "),
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(code: string) {
  const env = getEnv();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth exchange failed with ${response.status}`);
  }

  return response.json();
}

export async function refreshGoogleAccessToken(refreshToken: string) {
  const env = getEnv();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth refresh failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchGoogleProfile(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google profile fetch failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchCalendarList(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google calendar list failed with ${response.status}`);
  }

  const json = await response.json();
  return (json.items ?? []).map((calendar: Record<string, unknown>) => String(calendar.id));
}

export const getGoogleConnection = internalQuery({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .collect();

    return rows[0] ?? null;
  },
});

export const getAppConfig = internalQuery({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("appConfig")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .collect();

    return rows[0] ?? null;
  },
});

export const upsertGoogleConnection = internalMutation({
  args: {
    ownerKey: v.string(),
    googleEmail: v.string(),
    accessTokenEnc: v.string(),
    refreshTokenEnc: v.string(),
    expiryAt: v.number(),
    scope: v.array(v.string()),
    calendarIds: v.array(v.string()),
    status: v.union(v.literal("active"), v.literal("stale"), v.literal("revoked")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("googleConnections")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("googleConnections", {
        ...args,
        updatedAt: now,
      });
    }

    const appConfig = await ctx.db
      .query("appConfig")
      .withIndex("by_owner", (query) => query.eq("ownerKey", args.ownerKey))
      .unique();

    if (appConfig) {
      await ctx.db.patch(appConfig._id, {
        googleCalendarDefaultId: args.calendarIds[0] ?? getEnv().GOOGLE_CALENDAR_DEFAULT_ID,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("appConfig", {
        ownerKey: args.ownerKey,
        timezone: getEnv().DEFAULT_TIMEZONE,
        dailyDigestHour: 6,
        dailyDigestMinute: 0,
        telegramDigestChatId: getEnv().TELEGRAM_DEFAULT_CHAT_ID,
        googleCalendarDefaultId: args.calendarIds[0] ?? getEnv().GOOGLE_CALENDAR_DEFAULT_ID,
        locale: getEnv().DEFAULT_LOCALE,
        updatedAt: now,
      });
    }
  },
});

export async function getValidGoogleAccessToken(
  ctx: {
    runQuery: Function;
    runMutation: Function;
  },
  ownerKey: string
) {
  const connection = await ctx.runQuery(internal.calendar.oauth.getGoogleConnection, { ownerKey });
  if (!connection) {
    return null;
  }

  if (connection.expiryAt > Date.now() + 60_000) {
    return connection.accessTokenEnc;
  }

  const refreshed = await refreshGoogleAccessToken(connection.refreshTokenEnc);
  await ctx.runMutation(internal.calendar.oauth.upsertGoogleConnection, {
    ownerKey,
    googleEmail: connection.googleEmail,
    accessTokenEnc: refreshed.access_token,
    refreshTokenEnc: refreshed.refresh_token ?? connection.refreshTokenEnc,
    expiryAt: Date.now() + Number(refreshed.expires_in ?? 3600) * 1000,
    scope: connection.scope,
    calendarIds: connection.calendarIds,
    status: "active",
  });

  return refreshed.access_token;
}
