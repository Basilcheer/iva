// Nitro scheduled task — thin spawner, replaces deploy/iva-memory-weekly.{service,timer}.
// See memory-daily.ts for the shared rationale (local-time cron, flock, no logic moved here).
import { defineSchedule } from "eve/schedules";
import { memoryRollupJob } from "../lib/schedule-paths.js";
import { SCHEDULE_CRON } from "../lib/schedule-table.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

export default defineSchedule({
  cron: SCHEDULE_CRON["memory-weekly"],
  run({ waitUntil }) {
    waitUntil(runScheduledJob(memoryRollupJob("weekly")));
  },
});
