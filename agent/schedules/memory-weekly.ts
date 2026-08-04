// Nitro scheduled task — thin spawner, replaces deploy/iva-memory-weekly.{service,timer}.
// See memory-daily.ts for the shared rationale (local-time cron, flock, no logic moved here).
import { defineSchedule } from "eve/schedules";
import { memoryRollupJob } from "../lib/schedule-paths.mjs";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.mjs";

export default defineSchedule({
  cron: "15 4 * * 1",
  run({ waitUntil }) {
    waitUntil(runScheduledJob(memoryRollupJob("weekly")));
  },
});
