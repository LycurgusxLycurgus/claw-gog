import { defaultCalendarId, googleRequest } from "./client.ts";

export async function deleteEvent(accessToken: string, eventId: string, calendarId = defaultCalendarId()) {
  return googleRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
    },
    { accessToken }
  );
}
