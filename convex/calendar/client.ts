import { getEnv } from "../app/env";

type TokenCarrier = {
  accessToken: string;
};

export async function googleRequest(path: string, init: RequestInit, token: TokenCarrier) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Google request failed: ${response.status} ${response.statusText}`);
  }

  if (response.status === 204) {
    return { ok: true };
  }

  return response.json();
}

export function defaultCalendarId() {
  return getEnv().GOOGLE_CALENDAR_DEFAULT_ID;
}
