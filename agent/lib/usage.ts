// Контракт записи расхода токенов: форма строки usage.jsonl, путь лога и дозапись.
// Живёт в authored tree, потому что пишет его хук agent/hooks/usage.ts, а eve пересобирает
// дерево при старте — специфайер в scripts/ утащил бы операционный код в бандл (issue #176).
//
// Отчётность по тому же логу (чтение, окна, формат) осталась в scripts/lib/usage.ts: её
// грузит `iva usage` на установке, где authored tree отсутствует или недописан (ADR-0003),
// поэтому обратный импорт оттуда сюда невозможен. Общего кода у половин нет — общий у них
// сам файл, и это пинует round-trip тест в scripts/lib/usage.test.ts.
//
// Лог живёт в data/usage.jsonl (ASSISTANT_DATA_DIR, дефолт ./data) — рядом с tasks.json,
// gitignored, НЕ в vault (иначе ночной doctor коммитил бы растущий лог в репо памяти).
// Одна строка JSONL на шаг модели; ход (turn) = несколько шагов, группируем по turnId.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface UsageRecord {
  ts: string;
  source: string;
  provider: string;
  model: string;
  sessionId: string;
  turnId: string;
  step: number;
  subagent?: string;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface TurnLike {
  readonly id?: string;
  readonly sequence?: number;
}

const defaultDir = (): string => process.env.ASSISTANT_DATA_DIR || "data";

export function usageFilePath(dataDir = defaultDir()): string {
  return join(dataDir, "usage.jsonl");
}

// Sync append (как transcript.ts) — короткая дозапись против латентности модели, без
// interleave от конкурентных асинхронных записей.
export function appendUsage(record: UsageRecord, dataDir = defaultDir()): void {
  const file = usageFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Ключ хода для записи инлайн-субагента: ход РОДИТЕЛЯ плюс суффикс с именем субагента.
 * Живёт рядом с записью, а не в хуке, чтобы правило и его чтение не разъезжались.
 *
 * Фолбэки повторяют канон самого eve (`turnId.length > 0 ? turnId : turn_<sequence>`):
 * `ctx.session.turn.id` бывает ПУСТОЙ строкой между ходами, поэтому `??` тут не годится —
 * пустая строка дала бы ключ "#planner" и склеила бы разные ходы в один.
 */
export function subagentTurnId(
  turn: TurnLike | undefined,
  subagentName: string | undefined,
  childTurnId?: string,
): string {
  const bySequence =
    typeof turn?.sequence === "number" ? `turn_${turn.sequence}` : "";
  const parentTurnId = turn?.id || bySequence || childTurnId || "";
  return `${parentTurnId}#${subagentName || "subagent"}`;
}
