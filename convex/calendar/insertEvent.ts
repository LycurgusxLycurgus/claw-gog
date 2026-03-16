import { defaultCalendarId, googleRequest } from "./client";

export async function insertEvent(accessToken: string, payload: Record<string, unknown>, calendarId = defaultCalendarId()) {
  const conferenceDataVersion = payload.conferenceData ? "?conferenceDataVersion=1&sendUpdates=all" : "?sendUpdates=all";
  return googleRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events${conferenceDataVersion}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    { accessToken }
  );
}
