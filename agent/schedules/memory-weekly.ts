// Nitro scheduled task — thin spawner, replaces deploy/iva-memory-weekly.{service,timer}.
// See memory-daily.ts for the shared rationale (local-time cron, flock, no logic moved here).
import { join } from "node:path";
import { defineSchedule } from "eve/schedules";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.mjs";

export default defineSchedule({
  cron: "15 4 * * 1",
  run({ waitUntil }) {
    const root = process.cwd();
    const dataDirRaw = process.env.ASSISTANT_DATA_DIR ?? "data";
    const dataDir = dataDirRaw.startsWith("/") ? dataDirRaw : join(root, dataDirRaw);
    waitUntil(
      runScheduledJob({
        name: "memory-weekly",
        argv: ["scripts/memory/rollup.ts", "weekly"],
        root,
        nodeBin: process.execPath,
        lockPath: join(root, ".memory.lock"),
        statusPath: join(dataDir, "rollup-status.json"),
      }),
    );
  },
});
