import { defaultCalendarId, googleRequest } from "./client";

export async function deleteEvent(accessToken: string, eventId: string, calendarId = defaultCalendarId()) {
  return googleRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
    },
    { accessToken }
  );
}
