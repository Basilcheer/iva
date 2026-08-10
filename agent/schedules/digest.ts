// Nitro scheduled task for the morning digest. Unlike the memory-* schedules this one has
// no systemd predecessor — scripts/daily-digest.ts was always command-only (/digest), and a
// surprise unsolicited morning message is not acceptable, so this fires OFF by default: it
// reads data/settings.json at fire time (not at discovery/compile time, so a toggle flip
// applies on the very next tick without a restart) and returns immediately unless
// digestSchedule.enabled is explicitly true. No lockPath: the digest doesn't touch
// vault/CORE.md or MOC.md, so it doesn't need to serialize with the memory rollups.
import { defineSchedule } from "eve/schedules";
import { readSettings } from "../lib/settings.js";
import { resolvePaths } from "../lib/schedule-paths.js";
import { SCHEDULE_CRON } from "../lib/schedule-table.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

export default defineSchedule({
  cron: SCHEDULE_CRON.digest,
  run({ waitUntil }) {
    const settings = readSettings() as {
      digestSchedule?: { enabled?: boolean };
    };
    if (settings.digestSchedule?.enabled !== true) return;

    const { root, statusPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "digest",
        argv: ["scripts/daily-digest.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
      }),
    );
  },
});
