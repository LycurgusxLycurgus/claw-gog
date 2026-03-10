import { defaultCalendarId, googleRequest } from "./client.ts";

export async function updateEvent(accessToken: string, eventId: string, payload: Record<string, unknown>, calendarId = defaultCalendarId()) {
  return googleRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
    },
    { accessToken }
  );
}
