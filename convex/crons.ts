import { cronJobs } from "convex/server";
import { api } from "./_generated/api.js";

const crons = cronJobs();

crons.daily(
  "daily digest 6am bogota",
  {
    hourUTC: 11,
    minuteUTC: 0,
  },
  api.assistant.sendDailyDigest.runDailyDigest
);

export default crons;
