// Типы для usage.mjs (чистый ESM) — чтобы tsgo-потребители (agent/hooks/usage.ts) не ловили
// TS7016/TS2305. Сводки возвращают разную форму по окну — типизируем как unknown-объект.
export interface UsageRecord {
  ts: string;
  source: string;
  provider: string;
  model: string;
  sessionId: string;
  /**
   * Ход, к которому относится шаг. Шаг субагента пишется с sessionId родителя и turnId
   * вида "<ход родителя>#<субагент>" — ключ уникален, а часть до "#" сохраняет привязку
   * к ходу (agent/hooks/usage.ts, scripts/lib/usage.mjs).
   */
  turnId: string;
  step: number;
  subagent?: string;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function subagentTurnId(
  turn: { id?: string; sequence?: number } | undefined,
  subagentName: string | undefined,
  childTurnId?: string,
): string;
export function usageFilePath(dataDir?: string): string;
export function appendUsage(record: UsageRecord, dataDir?: string): void;
export function readEntries(dataDir?: string): UsageRecord[];
export function parseWindow(arg?: string): string;
export function summarize(
  entries: UsageRecord[],
  opts?: { window?: string; now?: number; tz?: string },
): Record<string, unknown>;
export function formatUsageReport(aggregate: Record<string, unknown>): string;
