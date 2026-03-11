export function composePrompt(input: {
  nowIso: string;
  timezone: string;
  appName?: string;
  connectionStatus?: string;
  defaultCalendarId?: string;
  selectedCalendarIds?: string[];
  mode?: "chat" | "read" | "mutate";
  transcript: Array<{ role: string; text: string }>;
  message: string;
  agentProfile?: {
    name: string;
    creature: string;
    vibe: string;
    visibleDescription: string;
    hiddenOperatorNotes: string;
  } | null;
  userProfile?: {
    displayName: string;
    preferredName: string;
    timezone: string;
    locale: string;
    notes?: string;
  } | null;
  fragments?: Array<{ kind: string; title: string; bodyMarkdown: string }>;
  topMemories?: string[];
  todayNote?: string;
}) {
  const history = input.transcript.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
  const fragments = (input.fragments ?? [])
    .map((fragment) => `${fragment.kind} / ${fragment.title}\n${fragment.bodyMarkdown}`)
    .join("\n\n");
  const memoryBlock = (input.topMemories ?? []).length ? (input.topMemories ?? []).map((memory) => `- ${memory}`).join("\n") : "none";
  const selectedCalendars = (input.selectedCalendarIds ?? []).length ? input.selectedCalendarIds?.join(", ") : "none";

  return [
    `You are ${input.appName ?? input.agentProfile?.name ?? "BridgeClaw"}, a Telegram-first personal calendar assistant running inside the claw-gog app.`,
    `Current time: ${input.nowIso}`,
    `Timezone: ${input.timezone}`,
    `Mode: ${input.mode ?? "chat"}`,
    `Google Calendar connection: ${input.connectionStatus ?? "unknown"}`,
    `Default calendar id: ${input.defaultCalendarId ?? "unknown"}`,
    `Selected calendar ids: ${selectedCalendars}`,
    input.agentProfile
      ? `Agent profile: ${input.agentProfile.name} | ${input.agentProfile.creature} | ${input.agentProfile.vibe}\nVisible description: ${input.agentProfile.visibleDescription}\nOperator notes: ${input.agentProfile.hiddenOperatorNotes}`
      : "Agent profile: BridgeClaw | calendar claw | concise and operational",
    input.userProfile
      ? `User profile: ${input.userProfile.preferredName} (${input.userProfile.displayName})\nUser timezone: ${input.userProfile.timezone}\nUser locale: ${input.userProfile.locale}\nUser notes: ${input.userProfile.notes ?? "none"}`
      : "User profile: unknown",
    fragments ? `Workspace fragments:\n${fragments}` : "Workspace fragments: none",
    `Durable memory:\n${memoryBlock}`,
    `Today's note: ${input.todayNote ?? "none"}`,
    "Reply concisely. Return final-user text only. Never expose internal reasoning, scratchpad, or thought summaries.",
    "If the user asks about schedules, agenda, today, tomorrow, next week, or date ranges, use the available calendar tool instead of answering from memory.",
    history ? `Recent transcript:\n${history}` : "Recent transcript: none",
    `User message: ${input.message}`,
  ].join("\n\n");
}
