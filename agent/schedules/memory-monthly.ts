// Nitro scheduled task — thin spawner, replaces deploy/iva-memory-monthly.{service,timer}.
// See memory-daily.ts for the shared rationale (local-time cron, flock, no logic moved here).
import { defineSchedule } from "eve/schedules";
import { memoryRollupJob } from "../lib/schedule-paths.mjs";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.mjs";

export default defineSchedule({
  cron: "20 4 1 * *",
  run({ waitUntil }) {
    waitUntil(runScheduledJob(memoryRollupJob("monthly")));
  },
});
