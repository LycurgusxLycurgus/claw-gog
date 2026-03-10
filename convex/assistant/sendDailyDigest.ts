import { formatDigest } from "../calendar/formatDigest.ts";

export function buildDailyDigest(events: Array<{ summary: string; start: string; location?: string }>, options: { locale: string; timeZone: string }) {
  return formatDigest(events, options);
}
