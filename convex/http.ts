import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { api } from "./_generated/api.js";
import { getEnv } from "./app/env";
import { jsonError } from "./shared/errors";
import { createCorrelationId } from "./shared/log";
import { normalizeUpdate } from "./telegram/normalizeUpdate";
import { isAllowedTelegramUser, verifyTelegramSecret } from "./telegram/verify";

const http = httpRouter();

function corsHeaders() {
  return {
    "access-control-allow-origin": getEnv().APP_BASE_URL,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
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
  path: "/telegram/webhook/:secret",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const secret = url.pathname.split("/").at(-1) ?? "";
    const correlationId = createCorrelationId();

    if (!verifyTelegramSecret(secret)) {
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
