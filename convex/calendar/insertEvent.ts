import { defaultCalendarId, googleRequest } from "./client.ts";

export async function insertEvent(accessToken: string, payload: Record<string, unknown>, calendarId = defaultCalendarId()) {
  return googleRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    { accessToken }
  );
}
