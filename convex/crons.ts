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

crons.interval(
  "heartbeat dispatcher hourly",
  {
    hours: 1,
  },
  api.assistant.sendHeartbeat.runHeartbeat
);

crons.interval(
  "watch jobs dispatcher hourly",
  {
    hours: 1,
  },
  api.watchers.jobs.runDueWatchJobs
);

export default crons;
