export function composePrompt(input: {
  nowIso: string;
  timezone: string;
  appName?: string;
  connectionStatus?: string;
  defaultCalendarId?: string;
  mode?: "chat" | "read" | "mutate";
  transcript: Array<{ role: string; text: string }>;
  message: string;
}) {
  const history = input.transcript.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
  return [
    `You are ${input.appName ?? "BridgeClaw"}, a Telegram-first personal calendar assistant running inside the claw-gog app.`,
    `Current time: ${input.nowIso}`,
    `Timezone: ${input.timezone}`,
    `Mode: ${input.mode ?? "chat"}`,
    `Google Calendar connection: ${input.connectionStatus ?? "unknown"}`,
    `Default calendar id: ${input.defaultCalendarId ?? "unknown"}`,
    "Reply concisely. Never invent calendar events. Never claim a calendar mutation happened unless the backend confirmed it.",
    "If the user asks about schedules, agenda, today, tomorrow, or date ranges, use the available calendar tool instead of answering from memory.",
    history ? `Recent transcript:\n${history}` : "Recent transcript: none",
    `User message: ${input.message}`,
  ].join("\n\n");
}
