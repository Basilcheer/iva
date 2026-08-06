// Учёт расхода токенов — ЕДИНЫЙ источник правды по формату usage.jsonl, чтению и сводкам.
// Переиспользуется хуком (запись: agent/hooks/usage.ts), Telegram-мостом и CLI `iva usage`
// (чтение). Чистый ESM (только node-builtins) — бандлится в eve и работает в bare-node.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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

type UsageWindow =
  "last" | "today" | "week" | "month" | "by-model" | "by-source";
type AggregateWindow = Exclude<UsageWindow, "last" | "by-model" | "by-source">;

interface Totals {
  readonly in: number;
  readonly out: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly steps: number;
  readonly turns: number;
}

interface UsageRow extends Totals {
  readonly key: string;
}

interface LastTurn extends Totals {
  readonly model: string;
  readonly source: string;
  readonly subagent: string | null;
  readonly when: string;
  readonly contextFromSubagent: boolean;
}

interface LastSummary {
  readonly window: "last";
  readonly last: LastTurn | null;
}

interface ByModelSummary {
  readonly window: "by-model";
  readonly rows: UsageRow[];
  readonly totals: Totals;
}

interface BySourceSummary {
  readonly window: "by-source";
  readonly rows: UsageRow[];
  readonly totals: Totals;
}

interface WindowSummary {
  readonly window: AggregateWindow;
  readonly totals: Totals;
  readonly bySource: UsageRow[];
  readonly byModel: UsageRow[];
}

type UsageSummary =
  LastSummary | ByModelSummary | BySourceSummary | WindowSummary;

interface SummarizeOptions {
  readonly window?: UsageWindow;
  readonly now?: number;
  readonly tz?: string;
}

interface LegacySummarizeOptions {
  readonly window?: string;
  readonly now?: number;
  readonly tz?: string;
}

interface TurnLike {
  readonly id?: string;
  readonly sequence?: number;
}

interface Accumulator {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  steps: number;
  readonly turns: Set<string>;
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

// Толерантный парсер: нет файла → пусто; битую строку (обрыв при падении на середине
// append) — молча пропускаем.
export function readEntries(dataDir = defaultDir()): UsageRecord[] {
  let raw: string;
  try {
    raw = readFileSync(usageFilePath(dataDir), "utf8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as UsageRecord);
    } catch {
      /* битая/частичная строка — пропускаем */
    }
  }
  return out;
}

// Нормализуем аргумент команды → допустимое окно (дефолт last).
export function parseWindow(arg?: string): UsageWindow {
  const normalized = (arg || "")
    .trim()
    .toLowerCase()
    .replace(/^by[ -]/, "by-");
  const windows: readonly UsageWindow[] = [
    "last",
    "today",
    "week",
    "month",
    "by-model",
    "by-source",
  ];
  return windows.includes(normalized as UsageWindow)
    ? (normalized as UsageWindow)
    : "last";
}

// Локальная дата YYYY-MM-DD в TZ пользователя (как transcript.ts/telegram.ts) — строковое
// сравнение, не ловит naive-UTC-midnight баг.
function localDate(ts: string | number, tz: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

function inWindow(
  entry: UsageRecord,
  window: string,
  now: number,
  tz: string | undefined,
): boolean {
  const time = Date.parse(entry.ts);
  if (Number.isNaN(time)) return false;
  if (window === "today") return localDate(entry.ts, tz) === localDate(now, tz);
  if (window === "month")
    return (
      localDate(entry.ts, tz).slice(0, 7) === localDate(now, tz).slice(0, 7)
    );
  if (window === "week") return time >= now - 7 * 86400000;
  return true; // lifetime — by-model/by-source
}

// Ход субагента пишется как "<ход родителя>#<субагент>" (agent/hooks/usage.ts): ключ
// уникален, но принадлежит ходу родителя — для группировки берём часть до "#".
const baseTurnId = (turnId: string | undefined): string =>
  String(turnId ?? "").split("#")[0];
const turnKey = (entry: UsageRecord): string =>
  `${entry.sessionId}:${baseTurnId(entry.turnId)}`;

/**
 * Ключ хода для записи инлайн-субагента: ход РОДИТЕЛЯ плюс суффикс с именем субагента.
 * Живёт здесь, а не в хуке, чтобы правило и его чтение не разъезжались.
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

const blank = (): Accumulator => ({
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  steps: 0,
  turns: new Set<string>(),
});

function add(accumulator: Accumulator, entry: UsageRecord): void {
  accumulator.in += entry.in || 0;
  accumulator.out += entry.out || 0;
  accumulator.cacheRead += entry.cacheRead || 0;
  accumulator.cacheWrite += entry.cacheWrite || 0;
  accumulator.total += entry.total || 0;
  accumulator.steps += 1;
  accumulator.turns.add(turnKey(entry));
}

const finalize = (accumulator: Accumulator): Totals => ({
  in: accumulator.in,
  out: accumulator.out,
  cacheRead: accumulator.cacheRead,
  cacheWrite: accumulator.cacheWrite,
  total: accumulator.total,
  steps: accumulator.steps,
  turns: accumulator.turns.size,
});

function rowsOf(map: Map<string, Accumulator>): UsageRow[] {
  return [...map]
    .map(([key, accumulator]) => ({ key, ...finalize(accumulator) }))
    .sort((left, right) => right.total - left.total);
}

export function summarize(
  entries: UsageRecord[],
  options: SummarizeOptions & { readonly window: "last" },
): LastSummary;
export function summarize(
  entries: UsageRecord[],
  options: SummarizeOptions & { readonly window: "by-model" | "by-source" },
): ByModelSummary | BySourceSummary;
export function summarize(
  entries: UsageRecord[],
  options: SummarizeOptions & { readonly window: AggregateWindow },
): WindowSummary;
export function summarize(
  entries: UsageRecord[],
  options?: SummarizeOptions,
): UsageSummary;
export function summarize(
  entries: UsageRecord[],
  options?: LegacySummarizeOptions,
): Record<string, unknown>;
export function summarize(
  entries: UsageRecord[],
  { window = "last", now = Date.now(), tz }: LegacySummarizeOptions = {},
): UsageSummary | Record<string, unknown> {
  if (window === "last") {
    if (!entries.length) return { window, last: null };
    const lastEntry = entries[entries.length - 1];
    const key = turnKey(lastEntry);
    const accumulator = blank();
    let model = lastEntry.model;
    const source = lastEntry.source;
    let subagent: string | null = null;
    const when = lastEntry.ts;
    let mainContext: number | undefined;
    let anyContext: number | undefined;
    for (const entry of entries) {
      if (turnKey(entry) !== key) continue;
      add(accumulator, entry);
      model = entry.model;
      anyContext = entry.in || 0;
      if (entry.subagent || String(entry.turnId ?? "").includes("#"))
        subagent = entry.subagent ?? subagent;
      else mainContext = entry.in || 0;
    }
    const context = mainContext ?? anyContext ?? 0;
    return {
      window,
      last: {
        ...finalize(accumulator),
        in: context,
        contextFromSubagent:
          mainContext === undefined && anyContext !== undefined,
        model,
        source,
        subagent,
        when,
      },
    };
  }
  if (window === "by-model" || window === "by-source") {
    const keyOf =
      window === "by-model"
        ? (entry: UsageRecord): string => entry.model || "?"
        : (entry: UsageRecord): string => entry.source || "?";
    const groups = new Map<string, Accumulator>();
    const total = blank();
    for (const entry of entries) {
      const key = keyOf(entry);
      if (!groups.has(key)) groups.set(key, blank());
      const group = groups.get(key);
      if (group) add(group, entry);
      add(total, entry);
    }
    return { window, rows: rowsOf(groups), totals: finalize(total) };
  }
  const matching = entries.filter((entry) => inWindow(entry, window, now, tz));
  const total = blank();
  const bySource = new Map<string, Accumulator>();
  const byModel = new Map<string, Accumulator>();
  for (const entry of matching) {
    add(total, entry);
    const source = entry.source || "?";
    if (!bySource.has(source)) bySource.set(source, blank());
    const sourceGroup = bySource.get(source);
    if (sourceGroup) add(sourceGroup, entry);
    const model = entry.model || "?";
    if (!byModel.has(model)) byModel.set(model, blank());
    const modelGroup = byModel.get(model);
    if (modelGroup) add(modelGroup, entry);
  }
  return {
    window,
    totals: finalize(total),
    bySource: rowsOf(bySource),
    byModel: rowsOf(byModel),
  };
}

const WINDOW_LABEL: Record<UsageWindow, string> = {
  last: "Last turn",
  today: "Today",
  week: "Last 7 days",
  month: "This month",
  "by-model": "By model",
  "by-source": "By source",
};
const SOURCE_LABEL: Record<string, string> = {
  telegram: "chat",
  http: "background (cron/digest)",
  unknown: "other",
};
const sourceLabel = (key: unknown): string => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve the declaration-era formatter's permissive String coercion.
  const normalized = String(key ?? "").replace(/^channel:/, "");
  return SOURCE_LABEL[normalized] || normalized || "other";
};
const num = (value: number | undefined): string =>
  String(value ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const plural = (value: number, word: string): string =>
  `${num(value)} ${word}${value === 1 ? "" : "s"}`;

export function formatUsageReport(aggregate: UsageSummary): string;
export function formatUsageReport(aggregate: Record<string, unknown>): string;
export function formatUsageReport(
  aggregate: UsageSummary | Record<string, unknown>,
): string {
  const summary = aggregate as UsageSummary;
  if (summary.window === "last") {
    if (!summary.last) return "No usage logged yet.";
    const last = summary.last;
    const subagent = last.subagent ? ` (+subagent ${last.subagent})` : "";
    return [
      `Last turn: ${num(last.total)} tokens${subagent}`,
      `context ${last.contextFromSubagent ? "~" : ""}${num(last.in)}${last.contextFromSubagent ? " (subagent step)" : ""}` +
        ` · out ${num(last.out)}${last.cacheRead ? ` · cached ${num(last.cacheRead)}` : ""}`,
      `${plural(last.steps, "step")} · ${last.model} · ${sourceLabel(last.source)}`,
    ].join("\n");
  }
  if (summary.window === "by-model" || summary.window === "by-source") {
    if (!summary.rows.length) return "No usage logged yet.";
    const lines = summary.rows.map(
      (row) =>
        `• ${summary.window === "by-source" ? sourceLabel(row.key) : row.key}: ${num(row.total)} tokens (${plural(row.turns, "turn")})`,
    );
    return [
      `${WINDOW_LABEL[summary.window]} (total ${num(summary.totals.total)} tokens):`,
      ...lines,
    ].join("\n");
  }
  const total = summary.totals;
  if (!total.steps) return `${WINDOW_LABEL[summary.window]}: no usage.`;
  const output = [
    `${WINDOW_LABEL[summary.window]}: ${num(total.total)} tokens (in ${num(total.in)} / out ${num(total.out)}) · ${plural(total.turns, "turn")}`,
  ];
  if (summary.bySource.length > 1) {
    output.push("Sources:");
    for (const row of summary.bySource)
      output.push(`• ${sourceLabel(row.key)}: ${num(row.total)}`);
  }
  if (summary.byModel.length > 1) {
    output.push("Models:");
    for (const row of summary.byModel)
      output.push(`• ${row.key}: ${num(row.total)}`);
  }
  return output.join("\n");
}
