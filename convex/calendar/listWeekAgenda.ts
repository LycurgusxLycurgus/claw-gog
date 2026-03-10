import { addDays } from "../shared/time";
import { defaultCalendarId, googleRequest } from "./client";

export async function listAgendaRange(accessToken: string, start: Date, end: Date, calendarId = defaultCalendarId()) {
  const params = new URLSearchParams({
    orderBy: "startTime",
    singleEvents: "true",
    timeMax: end.toISOString(),
    timeMin: start.toISOString(),
  });

  const json = await googleRequest(`/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, { method: "GET" }, { accessToken });
  return (json.items ?? []).map((event: Record<string, any>) => ({
    id: event.id,
    summary: event.summary ?? "(untitled)",
    description: event.description ?? "",
    location: event.location ?? "",
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    status: event.status ?? "confirmed",
  }));
}

export async function listWeekAgenda(accessToken: string, calendarId = defaultCalendarId()) {
  const start = new Date();
  const end = addDays(start, 7);
  return listAgendaRange(accessToken, start, end, calendarId);
}
