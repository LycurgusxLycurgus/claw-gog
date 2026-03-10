import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";
import { getEnv } from "./app/env";
import { buildGoogleOauthUrl, exchangeGoogleCode, fetchCalendarList, fetchGoogleProfile } from "./calendar/oauth";
import { jsonError } from "./shared/errors";
import { createCorrelationId } from "./shared/log";
import { normalizeUpdate } from "./telegram/normalizeUpdate";
import { isAllowedTelegramUser, verifyTelegramSecret, verifyTelegramSecretHeader } from "./telegram/verify";

const http = httpRouter();

function corsHeaders() {
  return {
    "access-control-allow-origin": getEnv().APP_BASE_URL,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
    },
  });
}

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "bridgeclaw-calendar-app",
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...corsHeaders(),
        },
      }
    );
  }),
});

http.route({
  path: "/oauth/google/start",
  method: "GET",
  handler: httpAction(async () => {
    return redirect(buildGoogleOauthUrl(getEnv().APP_OWNER_KEY));
  }),
});

http.route({
  path: "/oauth/google/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? getEnv().APP_OWNER_KEY;

    if (!code) {
      return redirect(`${getEnv().APP_BASE_URL}/connect/google-error.html`);
    }

    try {
      const tokenResponse = await exchangeGoogleCode(code);
      const accessToken = String(tokenResponse.access_token);
      const refreshToken = String(tokenResponse.refresh_token ?? "");
      const scope = String(tokenResponse.scope ?? "").split(" ").filter(Boolean);
      const profile = await fetchGoogleProfile(accessToken);
      const calendarIds = await fetchCalendarList(accessToken);

      await ctx.runMutation(internal.calendar.oauth.upsertGoogleConnection, {
        ownerKey: state,
        googleEmail: String(profile.email ?? "unknown@example.com"),
        accessTokenEnc: accessToken,
        refreshTokenEnc: refreshToken,
        expiryAt: Date.now() + Number(tokenResponse.expires_in ?? 3600) * 1000,
        scope,
        calendarIds,
        status: "active",
      });

      return redirect(`${getEnv().APP_BASE_URL}/connect/google-success.html`);
    } catch {
      return redirect(`${getEnv().APP_BASE_URL}/connect/google-error.html`);
    }
  }),
});

http.route({
  pathPrefix: "/telegram/webhook/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const secret = url.pathname.slice("/telegram/webhook/".length);
    const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
    const correlationId = createCorrelationId();

    if (!verifyTelegramSecretHeader(secretHeader) && !verifyTelegramSecret(secret)) {
      return jsonError(403, "INVALID_WEBHOOK_SECRET", "Webhook secret mismatch", { correlationId });
    }

    const payload = await request.json();
    const normalized = normalizeUpdate(payload);
    if (!normalized) {
      return jsonError(400, "INVALID_TELEGRAM_UPDATE", "Unsupported Telegram payload", { correlationId });
    }

    if (!isAllowedTelegramUser(normalized.userId)) {
      return jsonError(403, "SENDER_NOT_ALLOWED", "Telegram sender is not allowlisted", { correlationId });
    }

    const result = await ctx.runAction(api.telegram.ingest.ingestTelegramMessage, {
      chatId: normalized.chatId,
      correlationId,
      text: normalized.text,
      userId: normalized.userId,
      username: normalized.username,
    });

    return Response.json({
      ok: true,
      correlationId,
      inbound: normalized,
      reply: result.text,
      status: "accepted",
    });
  }),
});

export default http;
