// Nitro scheduled task — thin spawner, replaces deploy/iva-memory-daily.{service,timer}.
// Fires in the PROCESS's local time (no timezone of its own — see agent/instrumentation.ts,
// which sets TZ from ASSISTANT_TIMEZONE at startup), so "0 4 * * *" means 04:00 local, same
// wall-clock target the old OnCalendar=*-*-* 04:00:00 __TIMEZONE__ timer fired at.
//
// No logic moves here: runScheduledJob spawns the SAME command the timer used to run
// (flock -w 900 .memory.lock node --env-file=.env scripts/memory/rollup.ts daily), under
// the same lock the doctor script also takes, so a parallel monthly/yearly rollup on
// Jan 1 still serializes instead of racing on CORE.md/MOC.md.
import { defineSchedule } from "eve/schedules";
import { memoryRollupJob } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.ts";

export default defineSchedule({
  cron: "0 4 * * *",
  run({ waitUntil }) {
    waitUntil(runScheduledJob(memoryRollupJob("daily")));
  },
});
