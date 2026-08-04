// Nitro scheduled task for the morning digest. Unlike the memory-* schedules this one has
// no systemd predecessor — scripts/daily-digest.ts was always command-only (/digest), and a
// surprise unsolicited morning message is not acceptable, so this fires OFF by default: it
// reads data/settings.json at fire time (not at discovery/compile time, so a toggle flip
// applies on the very next tick without a restart) and returns immediately unless
// digestSchedule.enabled is explicitly true. No lockPath: the digest doesn't touch
// vault/CORE.md or MOC.md, so it doesn't need to serialize with the memory rollups.
import { join } from "node:path";
import { defineSchedule } from "eve/schedules";
import { readSettings } from "../../scripts/lib/settings.mjs";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.mjs";

export default defineSchedule({
  cron: "0 8 * * *",
  run({ waitUntil }) {
    const settings = readSettings() as { digestSchedule?: { enabled?: boolean } };
    if (settings.digestSchedule?.enabled !== true) return;

    const root = process.cwd();
    const dataDirRaw = process.env.ASSISTANT_DATA_DIR ?? "data";
    const dataDir = dataDirRaw.startsWith("/") ? dataDirRaw : join(root, dataDirRaw);
    waitUntil(
      runScheduledJob({
        name: "digest",
        argv: ["scripts/daily-digest.ts"],
        root,
        nodeBin: process.execPath,
        statusPath: join(dataDir, "rollup-status.json"),
      }),
    );
  },
});
