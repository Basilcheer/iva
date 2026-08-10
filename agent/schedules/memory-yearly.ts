// Nitro scheduled task — thin spawner, replaces deploy/iva-memory-yearly.{service,timer}.
// See memory-daily.ts for the shared rationale (local-time cron, flock, no logic moved here).
import { defineSchedule } from "eve/schedules";
import { memoryRollupJob } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

export default defineSchedule({
  cron: "25 4 1 1 *",
  run({ waitUntil }) {
    waitUntil(runScheduledJob(memoryRollupJob("yearly")));
  },
});
