// Типы для schedule-migration.mjs (чистый ESM) — чтобы tsgo-потребитель agent/instrumentation.ts
// не ловил TS7016. Тот же паттерн, что run-status.d.mts / schedule-runner.d.mts рядом.
export const LEGACY_MEMORY_UNITS: readonly string[];

export interface RunScheduleMigrationOptions {
  readonly homedir?: string;
  readonly execImpl?: (args: readonly string[]) => {
    code: number;
    out?: string;
    err?: string;
    error?: unknown;
  };
  readonly statusPath?: string;
  readonly tz?: string;
  readonly log?: (...args: unknown[]) => void;
  readonly now?: () => number;
  readonly root?: string;
  readonly nodeBin?: string;
  readonly runJob?: (
    period: "daily" | "weekly" | "monthly" | "yearly",
  ) => Promise<unknown>;
}

export function runScheduleMigration(
  options?: RunScheduleMigrationOptions,
): Promise<void>;
