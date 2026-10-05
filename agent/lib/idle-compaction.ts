// Свёртка между ходами: история сессии пересказывается, пока человек ничего не ждёт.
//
// Порядок: хук шага пишет вход каждого шага; на turn.completed канал решает, пора ли; на
// следующем session.waiting (ход запаркован) занимает чат записью running + compacting и
// зовёт свой compact-роут (публичный compact eve отдаётся только роутам). Конец пересказа —
// успех, сбой или обрыв — eve тоже отмечает session.waiting, и тот же обработчик канала
// освобождает чат.
//
// Чат занят на время пересказа по трём причинам. Мост при порядке queue держит пришедшие
// сообщения в своей очереди на диске и отвечает «Сжимаю разговор, скоро отвечу.»
// (scripts/poller/queue.ts). Перезапуск посреди пересказа виден восстановлению так же, как
// оборванный ход (scripts/recover-interrupted-turns.ts): без этого сессия eve остаётся с
// занятым входом команд и зависает (c1, 05.10.2026). И вторая просьба не встаёт в очередь
// eve, пока первая не кончилась.
//
// Здесь только решение и счёт, в памяти процесса: после рестарта свёртка ждёт следующего
// хода, а выключение (off) забыто — цена один лишний пересказ на рестарт.
import { idleCompactionLimit } from "./compaction.ts";

type Turn = {
  /** Между turn.started и turn.completed: пересказ в это время — страховка eve, не наш. */
  open: boolean;
  /** Вход первого и последнего шага текущего хода; null — провайдер вход не назвал. */
  steps: number;
  first: number | null;
  last: number | null;
  /** Законченный ход дошёл до порога: на session.waiting пора просить пересказ. */
  due: boolean;
  /** После прошлого хода пересказ просили; compacted — eve довела его до конца. */
  asked: boolean;
  compacted: boolean;
  /** Законченный пересказ не увёл вход под порог: больше между ходами не сворачиваем. */
  off: boolean;
};
const turns = new Map<string, Turn>();

/** turn.started: открыть счёт хода. */
export function openIdleCompactionTurn(sessionId: string): void {
  const turn = turns.get(sessionId);
  const fresh = { open: true, steps: 0, first: null, last: null, due: false };
  if (turn) Object.assign(turn, fresh);
  else
    turns.set(sessionId, {
      ...fresh,
      asked: false,
      compacted: false,
      off: false,
    });
}

/** Вход шага открытой сессии; null — провайдер вход не назвал. */
export function recordStepInput(sessionId: string, tokens: number | null) {
  const turn = turns.get(sessionId);
  if (!turn) return;
  if (turn.steps++ === 0) turn.first = tokens;
  turn.last = tokens;
}

/**
 * compaction.completed. Пересказ внутри хода — страховка eve, она шлёт то же событие:
 * своим считаем только пересказ, который кончился, пока ход сессии закрыт.
 */
export function completeIdleCompaction(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (turn?.asked && !turn.open) turn.compacted = true;
}

/**
 * turn.completed: решить, пора ли сворачивать после этого хода. Пересказ, который дошёл до
 * конца и не увёл первый шаг следующего хода под порог, выключает себя: иначе каждый ход
 * платил бы за пересказ, который ничего не освобождает. Оборванный пересказ (сообщение при
 * порядке steer, сбой провайдера) не выключает ничего.
 */
export function closeIdleCompactionTurn(
  sessionId: string,
  windowTokens: number,
): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  turn.open = false;
  const limit = idleCompactionLimit(windowTokens);
  if (turn.asked) {
    if (turn.compacted && turn.first !== null && turn.first >= limit)
      turn.off = true;
    turn.asked = false;
    turn.compacted = false;
  }
  turn.due = !turn.off && limit > 0 && turn.last !== null && turn.last >= limit;
}

/**
 * session.waiting: если законченный ход дошёл до порога — занять чат и попросить eve
 * пересказать историю. Никогда не бросает: ход уже закончен, отказ оставляет историю как
 * была, следующий ход решит заново, страховка внутри хода остаётся.
 *
 * claimImpl занимает чат под пересказ; false — чат уже занят (пришло сообщение) или сессия
 * сброшена, тогда просьбы нет. requestImpl: true — eve приняла просьбу, false — сессии уже
 * нет. releaseImpl освобождает чат, если просьба не принята.
 */
export async function startIdleCompaction({
  sessionId,
  claimImpl,
  requestImpl,
  releaseImpl,
  logImpl = console.error,
}: {
  sessionId: string;
  claimImpl: () => boolean;
  requestImpl: (sessionId: string) => Promise<boolean>;
  releaseImpl: () => Promise<unknown>;
  logImpl?: (...parts: unknown[]) => void;
}): Promise<boolean> {
  const turn = turns.get(sessionId);
  if (!turn?.due) return false;
  turn.due = false;
  let accepted = false;
  try {
    if (!claimImpl()) return false;
    accepted = await requestImpl(sessionId);
  } catch (error) {
    logImpl("[telegram] свёртка между ходами не запрошена:", error);
  }
  if (accepted) {
    turn.asked = true;
    return true;
  }
  try {
    await releaseImpl();
  } catch (error) {
    logImpl("[telegram] чат после отказа свёртки не освобождён:", error);
  }
  return false;
}
