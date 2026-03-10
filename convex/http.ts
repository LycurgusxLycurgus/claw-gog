import { httpAction, httpRouter } from "convex/server";
import { jsonError } from "./shared/errors.ts";
import { createCorrelationId } from "./shared/log.ts";
import { normalizeUpdate } from "./telegram/normalizeUpdate.ts";
import { isAllowedTelegramUser, verifyTelegramSecret } from "./telegram/verify.ts";

const http = httpRouter();

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return Response.json({
      ok: true,
      service: "bridgeclaw-calendar-app",
      timestamp: new Date().toISOString(),
    });
  }),
});

http.route({
  path: "/telegram/webhook/:secret",
  method: "POST",
  handler: httpAction(async (_ctx, request) => {
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

    return Response.json({
      ok: true,
      correlationId,
      inbound: normalized,
      status: "accepted",
    });
  }),
});

export default http;
