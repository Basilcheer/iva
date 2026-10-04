// Свёртка между ходами: история сессии пересказывается, пока человек ничего не ждёт.
//
// Хук шага пишет вход каждого шага, канал на turn.completed спрашивает, пора ли, и зовёт
// свой compact-роут (публичный compact eve отдаётся только роутам). Сообщение, пришедшее во
// время свёртки, eve держит в своём входном буфере и начинает ход после неё; канал лишь
// подписывает ранний статус «Сжимаю разговор…» (idleCompactionRunning).
//
// Состояние в памяти процесса: после рестарта свёртка между ходами ждёт следующего хода, а
// подпись статуса возвращается к обычному индикатору. Порядок событий хранит eve, не этот
// модуль: от его записей зависит только текст статуса и момент просьбы.
import { idleCompactionLimit } from "./compaction.ts";

type Turn = {
  /** Вход первого и последнего шага текущего хода; null — провайдер вход не назвал. */
  steps: number;
  first: number | null;
  last: number | null;
  /** После прошлого хода свёртку просили; compacted — eve её довела до конца. */
  asked: boolean;
  compacted: boolean;
  /** Законченная свёртка не увела вход под порог: больше между ходами не сворачиваем. */
  off: boolean;
};
const turns = new Map<string, Turn>();
const running = new Map<string, { sessionId: string; at: number }>();

// Свёртка без compaction.completed (сбой пересказа, рестарт) подпись дольше не держит.
export const IDLE_COMPACTION_NOTE_MS = 3 * 60_000;

/** turn.started: открыть счёт хода. Начавшийся ход значит, что свёртка уже не идёт. */
export function openIdleCompactionTurn(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (turn) Object.assign(turn, { steps: 0, first: null, last: null });
  else
    turns.set(sessionId, {
      steps: 0,
      first: null,
      last: null,
      asked: false,
      compacted: false,
      off: false,
    });
  forgetRunning(sessionId);
}

/** Вход шага открытой сессии; null — провайдер вход не назвал. */
export function recordStepInput(sessionId: string, tokens: number | null) {
  const turn = turns.get(sessionId);
  if (!turn) return;
  if (turn.steps++ === 0) turn.first = tokens;
  turn.last = tokens;
}

/** compaction.completed: свёртка доведена до конца, подпись статуса больше не нужна. */
export function completeIdleCompaction(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (turn?.asked) turn.compacted = true;
  forgetRunning(sessionId);
}

function forgetRunning(sessionId: string): void {
  for (const [chatKey, entry] of running)
    if (entry.sessionId === sessionId) running.delete(chatKey);
}

/** Идёт ли в чате свёртка между ходами: от этого зависит только текст раннего статуса. */
export function idleCompactionRunning(
  chatKey: string,
  now = Date.now(),
): boolean {
  const entry = running.get(chatKey);
  if (!entry) return false;
  if (now - entry.at < IDLE_COMPACTION_NOTE_MS) return true;
  running.delete(chatKey);
  return false;
}

/**
 * Пора ли сворачивать после этого хода. Свёртка, которая дошла до конца и не увела первый
 * шаг следующего хода под порог, выключает себя до конца сессии: иначе каждый ход платил бы
 * за пересказ, который ничего не освобождает. Оборванная свёртка (ход по политике steer,
 * сбой провайдера) не выключает ничего.
 */
export function idleCompactionDue(
  sessionId: string,
  windowTokens: number,
): boolean {
  const turn = turns.get(sessionId);
  if (!turn) return false;
  const limit = idleCompactionLimit(windowTokens);
  if (turn.asked) {
    if (turn.compacted && turn.first !== null && turn.first >= limit)
      turn.off = true;
    turn.asked = false;
    turn.compacted = false;
  }
  return !turn.off && limit > 0 && turn.last !== null && turn.last >= limit;
}

/**
 * turn.completed: попросить eve свернуть историю, если пора. Никогда не бросает: ход уже
 * закончен, а отказ свёртки оставляет историю как была (следующий ход попросит снова,
 * страховка внутри хода остаётся).
 */
export async function compactIdleSession({
  sessionId,
  chatKey,
  windowTokens,
  requestImpl,
  now = Date.now,
  logImpl = console.error,
}: {
  sessionId: string;
  chatKey: string;
  windowTokens: number;
  /** true — eve приняла просьбу; false — сессии уже нет. */
  requestImpl: (sessionId: string) => Promise<boolean>;
  now?: () => number;
  logImpl?: (...parts: unknown[]) => void;
}): Promise<boolean> {
  if (!idleCompactionDue(sessionId, windowTokens)) return false;
  // Подпись ставим до просьбы: сообщение может прийти, пока eve её принимает.
  running.set(chatKey, { sessionId, at: now() });
  let accepted = false;
  try {
    accepted = await requestImpl(sessionId);
  } catch (error) {
    logImpl("[telegram] свёртка между ходами не запрошена:", error);
  }
  const turn = turns.get(sessionId);
  if (accepted) {
    if (turn) turn.asked = true;
    return true;
  }
  if (running.get(chatKey)?.sessionId === sessionId) running.delete(chatKey);
  return false;
}
