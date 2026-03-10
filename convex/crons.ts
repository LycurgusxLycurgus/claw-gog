import { cronJobs } from "convex/server";
import { api } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("daily digest placeholder", { hours: 24 }, api.assistant.sendDailyDigest.runDailyDigest, {
});

export default crons;
