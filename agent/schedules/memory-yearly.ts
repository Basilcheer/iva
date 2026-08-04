// Nitro scheduled task — thin spawner, replaces deploy/iva-memory-yearly.{service,timer}.
// See memory-daily.ts for the shared rationale (local-time cron, flock, no logic moved here).
import { join } from "node:path";
import { defineSchedule } from "eve/schedules";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.mjs";

export default defineSchedule({
  cron: "25 4 1 1 *",
  run({ waitUntil }) {
    const root = process.cwd();
    const dataDirRaw = process.env.ASSISTANT_DATA_DIR ?? "data";
    const dataDir = dataDirRaw.startsWith("/") ? dataDirRaw : join(root, dataDirRaw);
    waitUntil(
      runScheduledJob({
        name: "memory-yearly",
        argv: ["scripts/memory/rollup.ts", "yearly"],
        root,
        nodeBin: process.execPath,
        lockPath: join(root, ".memory.lock"),
        statusPath: join(dataDir, "rollup-status.json"),
      }),
    );
  },
});
