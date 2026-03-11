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

export async function listAgendaRangeAcrossCalendars(accessToken: string, start: Date, end: Date, calendarIds: string[]) {
  const uniqueCalendarIds = Array.from(new Set(calendarIds.filter(Boolean)));
  if (uniqueCalendarIds.length === 0) {
    return [];
  }

  const results = await Promise.all(uniqueCalendarIds.map((calendarId) => listAgendaRange(accessToken, start, end, calendarId)));
  return results
    .flat()
    .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime());
}

export async function listWeekAgenda(accessToken: string, calendarId = defaultCalendarId()) {
  const start = new Date();
  const end = addDays(start, 7);
  return listAgendaRange(accessToken, start, end, calendarId);
}

export async function listWeekAgendaAcrossCalendars(accessToken: string, calendarIds: string[]) {
  const start = new Date();
  const end = addDays(start, 7);
  return listAgendaRangeAcrossCalendars(accessToken, start, end, calendarIds);
}
