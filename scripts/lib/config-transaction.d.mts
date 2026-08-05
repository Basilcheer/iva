// Типы для config-transaction.mjs (чистый ESM) — чтобы tsgo-потребитель
// agent/instrumentation.ts не ловил TS7016. Тот же паттерн, что run-status.d.mts /
// schedule-runner.d.mts рядом. Только probeEveHealth используется извне scripts/,
// остальное — минимальные заглушки для полноты поверхности модуля.
export function pendingConfigPath(envPath: string): string;

export class ConfigTransactionError extends Error {
  constructor(
    message: string,
    options?: { phase?: string; rollbackFailed?: boolean; cause?: unknown },
  );
  readonly phase?: string;
  readonly rollbackFailed: boolean;
}

export interface ProbeEveHealthOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

// Polls GET <url> (must be the local http://127.0.0.1|localhost|::1/eve/v1/health
// route) until it responds ok, or throws once timeoutMs elapses.
export function probeEveHealth(
  url: string,
  options?: ProbeEveHealthOptions,
): Promise<void>;

export function recoverConfigTransaction(
  target: { envPath: string; services: readonly string[] },
  options?: Record<string, unknown>,
): Promise<boolean>;

export function applyConfigTransaction(
  target: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<unknown>;
