// Shared path resolution for agent/schedules/*.ts — root/dataDir/statusPath/lockPath were
// duplicated identically across all 5 schedule files; one place to change if the status
// filename, lock filename, or ASSISTANT_DATA_DIR resolution rule ever changes.
import { isAbsolute, join } from "node:path";

export interface SchedulePaths {
  readonly root: string;
  readonly dataDir: string;
  readonly statusPath: string;
  readonly memoryLockPath: string;
}

export function resolvePaths(): SchedulePaths {
  const root = process.cwd();
  const raw = process.env.ASSISTANT_DATA_DIR ?? "data";
  const dataDir = isAbsolute(raw) ? raw : join(root, raw);
  return {
    root,
    dataDir,
    statusPath: join(dataDir, "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
  };
}

export type MemoryPeriod = "daily" | "weekly" | "monthly" | "yearly";

// Same command shape every memory-*.ts schedule spawns: `flock -w 900 .memory.lock node
// --env-file=.env scripts/memory/rollup.ts <period>` — see agent/lib/schedule-runner.ts.
export function memoryRollupJob(period: MemoryPeriod) {
  const { root, statusPath, memoryLockPath } = resolvePaths();
  return {
    name: `memory-${period}`,
    argv: ["scripts/memory/rollup.ts", period],
    root,
    nodeBin: process.execPath,
    lockPath: memoryLockPath,
    statusPath,
  };
}
