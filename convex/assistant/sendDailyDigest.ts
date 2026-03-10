import { v } from "convex/values";
import { action } from "../_generated/server.js";
import { formatDigest } from "../calendar/formatDigest";

export function buildDailyDigest(events: Array<{ summary: string; start: string; location?: string }>, options: { locale: string; timeZone: string }) {
  return formatDigest(events, options);
}

export const runDailyDigest = action({
  args: {
    events: v.array(
      v.object({
        summary: v.string(),
        start: v.string(),
        location: v.optional(v.string()),
      })
    ),
    options: v.object({
      locale: v.string(),
      timeZone: v.string(),
    }),
  },
  handler: async (_ctx, args) => {
    return buildDailyDigest(args.events, args.options);
  },
});
