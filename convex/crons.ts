import { cronJobs } from "convex/server";

const crons = cronJobs();

crons.interval("daily digest placeholder", { hours: 24 }, "assistant/sendDailyDigest:buildDailyDigest", {
  events: [],
  options: { locale: "en", timeZone: "America/Bogota" },
});

export default crons;
