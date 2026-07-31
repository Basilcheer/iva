// Типы для rollup-turn.mjs (чистый ESM), используемого memory-скриптами.
export const DEFAULT_TURN_TIMEOUT_MS: number;

export class RollupTurnTimeoutError extends Error {
  constructor(label: string, timeoutMs: number);
  code: "ROLLUP_TURN_TIMEOUT";
  label: string;
}

export function withTurnTimeout<T>(
  fn: () => Promise<T>,
  options?: { timeoutMs?: number; label?: string },
): Promise<T>;

export function resolveTurnTimeoutMs(
  raw: string | undefined | null,
  options?: { warn?: (message: string) => void },
): number;

export const DEFAULT_CANCEL_TIMEOUT_MS: number;

export function cancelTurnQuietly(
  session: { cancel: (options?: { turnId?: string }) => Promise<unknown> },
  options?: { timeoutMs?: number },
): Promise<boolean>;
