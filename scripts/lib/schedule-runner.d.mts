// Типы для schedule-runner.mjs (чистый ESM) — чтобы tsgo-потребители (agent/schedules/*.ts,
// agent/instrumentation.ts через schedule-migration.mjs) не ловили TS7016. Тот же паттерн,
// что run-status.d.mts / i18n.d.mts рядом.
export interface RunScheduledJobOptions {
  readonly name: string;
  readonly argv: readonly string[];
  readonly root?: string;
  readonly nodeBin?: string;
  readonly lockPath?: string;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly guardMs?: number;
  readonly statusPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnImpl?: (...args: unknown[]) => unknown;
  readonly killImpl?: (pid: number, signal: string) => void;
  readonly now?: () => number;
  readonly log?: (...args: unknown[]) => void;
}

export interface RunScheduledJobResult {
  readonly skipped: boolean;
  readonly ok: boolean;
  readonly code?: number | null;
  readonly signal?: string | null;
  readonly error?: unknown;
}

export function runScheduledJob(options: RunScheduledJobOptions): Promise<RunScheduledJobResult>;
