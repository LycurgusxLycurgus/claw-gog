import { listWeekAgenda } from "./listWeekAgenda";

export async function findEventBySummary(accessToken: string, query: string) {
  const events = await listWeekAgenda(accessToken);
  const normalized = query.trim().toLowerCase();
  return events.find((event: { summary: string }) => event.summary.toLowerCase().includes(normalized)) ?? null;
}
