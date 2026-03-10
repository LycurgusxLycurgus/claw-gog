import { listWeekAgenda } from "./listWeekAgenda.ts";

export async function findEventBySummary(accessToken: string, query: string) {
  const events = await listWeekAgenda(accessToken);
  const normalized = query.trim().toLowerCase();
  return events.find((event) => event.summary.toLowerCase().includes(normalized)) ?? null;
}
