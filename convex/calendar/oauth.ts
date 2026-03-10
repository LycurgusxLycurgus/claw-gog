import { getEnv } from "../app/env.ts";

const GOOGLE_OAUTH_SCOPE = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export function buildGoogleOauthUrl(state: string) {
  const env = getEnv();
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    prompt: "consent",
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPE.join(" "),
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(code: string) {
  const env = getEnv();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth exchange failed with ${response.status}`);
  }

  return response.json();
}
