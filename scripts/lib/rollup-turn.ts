// Ход ночного роллапа: срок запуска, предел хода и чтение его событий одним владельцем.
//
// Предел живёт в ночном клиенте, а не в хуке агента: исключение хука eve превращает в
// turn.failed (node_modules/eve/docs/guides/hooks.md:177-179), а бюджет хода внутри платформы
// запрещает docs/philosophy.md. Клиент читает поток хода сам (for await по MessageResponse),
// считает наблюдаемые step.started и inputTokens из step.completed и при переходе предела один
// раз просит eve отменить ход вместе с задачами. Мягкий предел: вызов модели, на котором он
// сработал, уже идёт и может доработать до конца — его стоимость предел не ограничивает;
// повторные вызовы восстановления eve идут без step.started и счётчику не видны.

import {
  DEFAULT_TIMEOUT_MS,
  JOB_STOP_AT_ENV,
  JOB_STOP_GRACE_MS,
} from "#lib/schedule-runner.ts";

// Предел хода ночи. Замер 126 ходов source=http (.scratch/work/evidence/night-turn-replay.tsv;
// шаги — наблюдаемые step.completed, in — inputTokens без кэша):
//   установка  ходов  режется  чем
//   stan         53        0  —
//   oleg         31        0  —
//   enttse       42       11  все 11 ≥ 150 шагов и ≥ 10 M; не режутся (64, 7,9 M) и (106, 7,7 M)
// По in + cacheRead у stan попали бы 3 обычных хода, поэтому порог по inputTokens без кэша.
// Снимается вместе со старой ночью на этапе 1 ADR-0016 (ночь из четырёх шагов кода).
export const NIGHT_MAX_STEPS = 120;
export const NIGHT_MAX_INPUT_TOKENS = 8_000_000;
// Отмена и reset уборки — каждая не дольше трети срока остановки раннера: обе вместе
// укладываются в 90 с между «работу кончить» и SIGKILL.
export const NIGHT_CLEANUP_MS = JOB_STOP_GRACE_MS / 3;
// Дневной ход не начинается, если до срока меньше: он не успел бы ничего и оставил бы уборку.
export const NIGHT_MIN_TURN_MS = 5 * 60_000;

const MAX_TIMER_MS = 2 ** 31 - 1;

// Момент, когда работу сводки пора кончать (epoch ms). Срок один — срок запуска у раннера:
// раннер кладёт этот момент в окружение ребёнка (agent/lib/schedule-runner.ts). Ручной
// запуск мимо раннера получает тот же срок от своего старта. Кривое значение — ошибка:
// тихий дефолт снова развёл бы срок хода и потолок расписания.
export function resolveStopAt(raw: string | undefined, nowMs: number): number {
  if (raw === undefined || raw === "")
    return nowMs + DEFAULT_TIMEOUT_MS - JOB_STOP_GRACE_MS;
  const stopAt = Number(raw);
  // Прошедший момент — не срок: ход кончился бы, не начавшись. Node держит таймер в
  // 32-битном знаковом диапазоне: дальше он молча схлопывается в 1 мс.
  const ahead = stopAt - nowMs;
  if (!/^\d+$/u.test(raw) || ahead <= 0 || ahead > MAX_TIMER_MS)
    throw new TypeError(
      `${JOB_STOP_AT_ENV}=${raw} is not a future epoch time in milliseconds within ${MAX_TIMER_MS} ms from now`,
    );
  return stopAt;
}

type Outcome = "completed" | "cancelled" | "failed";
type Boundary = "session.waiting" | "session.completed" | "session.failed";

/** Что владелец потока помнит о ходе: не события, а их итог. */
export interface NightTurn {
  turnId: string | null;
  /** turn.completed | turn.cancelled | turn.failed своего хода. */
  outcome: Outcome | null;
  /** Последняя граница потока; любое событие после неё её снимает. */
  boundary: Boundary | null;
  /** Последний финальный message.completed своего хода (политика читателя). */
  message: string;
  steps: number;
  inputTokens: number;
  /** Каждый шаг назвал вход; иначе предел токенов не наблюдался. */
  tokensSeen: boolean;
  /** Своя отмена по пределу запрошена. */
  cutRequested: boolean;
}

/**
 * completed — ход кончился и граница прочитана; cut — обрез подтверждён (своя отмена,
 * turn.cancelled, граница); failed — ход не удался (turn.failed или чужая отмена);
 * session-failed — граница с отказом сессии; broken — конца нет (обрыв, пауза, abort,
 * исключение клиента): ход мог остаться живым.
 */
export type TurnVerdict =
  "completed" | "cut" | "failed" | "session-failed" | "broken";

const OUTCOMES: Readonly<Record<string, Outcome>> = {
  "turn.completed": "completed",
  "turn.cancelled": "cancelled",
  "turn.failed": "failed",
};
const BOUNDARIES = new Set([
  "session.waiting",
  "session.completed",
  "session.failed",
]);
const STEP_EVENTS = new Set(["step.started", "step.completed"]);

interface EventView {
  readonly type: string;
  readonly id: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function view(event: unknown): EventView {
  const record = isRecord(event) ? event : {};
  const meta = isRecord(record.meta) ? record.meta : {};
  return {
    type: typeof record.type === "string" ? record.type : "",
    id: typeof meta.id === "string" ? meta.id : null,
    data: isRecord(record.data) ? record.data : {},
  };
}

const validTokens = (usage: unknown): number | null => {
  const value = isRecord(usage) ? usage.inputTokens : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
};

/**
 * Читатель событий одного хода. observe возвращает true, когда предел перейдён и
 * отмену пора запросить (один раз за ход).
 */
export function nightTurnReader(log: (line: string) => void) {
  const turn: NightTurn = {
    turnId: null,
    outcome: null,
    boundary: null,
    message: "",
    steps: 0,
    inputTokens: 0,
    tokensSeen: true,
    cutRequested: false,
  };
  // Учтённые шаги по meta.id: транспортный повтор не удваивает счёт, повтор durable-шага
  // приходит с новыми id и считается снова (консервативно).
  const counted = new Set<string>();
  let foreignLogged = false;

  const ours = (event: EventView): boolean => {
    const turnId = event.data.turnId;
    if (typeof turnId !== "string") return true;
    turn.turnId ??= turnId;
    if (turnId === turn.turnId) return true;
    if (!foreignLogged)
      log(
        `events of a foreign turn ${turnId} are not counted (own turn ${turn.turnId})`,
      );
    foreignLogged = true;
    return false;
  };

  const firstSeen = (event: EventView): boolean => {
    if (event.id === null) return true;
    if (counted.has(event.id)) return false;
    counted.add(event.id);
    return true;
  };

  const overLimit = (): boolean =>
    !turn.cutRequested && turn.inputTokens >= NIGHT_MAX_INPUT_TOKENS;

  function step(event: EventView): boolean {
    if (!firstSeen(event)) return false;
    if (event.type === "step.started") {
      turn.steps += 1;
      const index = event.data.stepIndex;
      return (
        !turn.cutRequested &&
        typeof index === "number" &&
        index >= NIGHT_MAX_STEPS
      );
    }
    const tokens = validTokens(event.data.usage);
    if (tokens === null) {
      if (turn.tokensSeen)
        log(
          "a step came without usable usage.inputTokens — the token ceiling is not observed for this turn",
        );
      turn.tokensSeen = false;
      return false;
    }
    turn.inputTokens += tokens;
    return overLimit();
  }

  function observe(raw: unknown): boolean {
    const event = view(raw);
    if (BOUNDARIES.has(event.type)) {
      turn.boundary = event.type as Boundary;
      return false;
    }
    turn.boundary = null;
    if (!ours(event)) return false;
    if (STEP_EVENTS.has(event.type)) return step(event);
    const outcome = OUTCOMES[event.type];
    if (outcome) turn.outcome = outcome;
    if (
      event.type === "message.completed" &&
      event.data.finishReason !== "tool-calls"
    )
      turn.message =
        typeof event.data.message === "string" ? event.data.message : "";
    return false;
  }

  return { turn, observe };
}

/**
 * Один владелец читает поток хода до его конца. Предел — одна отмена своего хода с задачами
 * (cancel сам ограничен сроком и не бросает), затем чтение того же итератора дальше.
 * Итератор или обработчик бросил — ошибка возвращается рядом с тем, что успели прочитать.
 */
export async function readNightTurn(
  events: AsyncIterable<unknown>,
  cancel: (turnId: string) => Promise<unknown>,
  log: (line: string) => void,
): Promise<{ readonly turn: NightTurn; readonly error?: unknown }> {
  const reader = nightTurnReader(log);
  try {
    for await (const event of events) {
      if (!reader.observe(event) || reader.turn.turnId === null) continue;
      reader.turn.cutRequested = true;
      log(
        `turn ${reader.turn.turnId} passed the ceiling (${reader.turn.steps} steps, ${reader.turn.inputTokens} input tokens) — cancelling it with its tasks`,
      );
      await cancel(reader.turn.turnId);
    }
  } catch (error) {
    return { turn: reader.turn, error };
  }
  return { turn: reader.turn };
}

export function turnVerdict(turn: NightTurn, error?: unknown): TurnVerdict {
  if (error !== undefined) return "broken";
  if (turn.boundary === "session.failed") return "session-failed";
  if (turn.boundary === null || turn.outcome === null) return "broken";
  if (turn.outcome === "completed") return "completed";
  return turn.outcome === "cancelled" && turn.cutRequested ? "cut" : "failed";
}

/** Ход мог остаться живым: границы нет или граница — пауза без исхода. */
export const turnMayBeLive = (turn: NightTurn | null): boolean =>
  turn === null ||
  (turn.boundary !== "session.failed" &&
    (turn.boundary === null || turn.outcome === null));

/** Строка журнала об итоге хода. */
export function turnSummary(turn: NightTurn, verdict: TurnVerdict): string {
  const tokens = turn.tokensSeen
    ? `${turn.inputTokens} input tokens`
    : `${turn.inputTokens} input tokens (the token ceiling was not observed)`;
  return `turn ${turn.turnId ?? "(id unknown)"} ${verdict}: ${turn.steps} steps, ${tokens}`;
}
