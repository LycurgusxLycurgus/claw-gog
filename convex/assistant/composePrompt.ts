export function composePrompt(input: {
  nowIso: string;
  timezone: string;
  transcript: Array<{ role: string; text: string }>;
  message: string;
}) {
  const history = input.transcript.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
  return [
    "You are BridgeClaw, a Telegram-first personal calendar assistant.",
    `Current time: ${input.nowIso}`,
    `Timezone: ${input.timezone}`,
    "Reply concisely. Never claim a calendar mutation happened unless the backend confirmed it.",
    history ? `Recent transcript:\n${history}` : "Recent transcript: none",
    `User message: ${input.message}`,
  ].join("\n\n");
}
