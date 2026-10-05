// One Reminder turn against the eve client: create a session, read its event stream up to a
// turn boundary, and always reset the session. While the turn runs its owner may hand it a
// chat to watch (TurnWatch), so the /stop path that cancels a channel turn cancels this one
// too — the turn has no wall-clock cap, and only the silence watchdog or the owner ends it.
// The one exception is a caller that passes a signal: the proactive tick ends its turns at
// the run's IVA_JOB_STOP_AT, cancelling them on the server.
// The turn posts no working-status message, so the chat has no ⏹ button of its own there.
// It lives on the CLI half, not in `agent/`, and imports nothing from there: `iva remind`
// has to load on an install whose authored tree is missing or half-written, and the delivery
// child process runs the same turn.
import { writtenInLanguage } from "./notice-policy.ts";

/**
 * Виды хода через этот модуль — одно место списка. Ход называет свой вид заголовком
 * `x-iva-turn`, bearer-авторизация кладёт его в атрибут (agent/lib/eve-auth.ts, копия списка
 * там сверяется тестом), хук расхода пишет вид в `source`.
 */
export const REMINDER_TURN_KINDS = [
  "watch",
  "brief",
  "insight",
  "reminder",
  "signal",
  "alert",
] as const;

export type ReminderTurnKind = (typeof REMINDER_TURN_KINDS)[number];

export type ReminderClientOptions = {
  readonly host: string;
  readonly auth: { readonly bearer: () => Promise<string> };
  /** eve Client шлёт их с каждым запросом хода. */
  readonly headers?: Readonly<Record<string, string>>;
};

/** Заголовок вида хода; вид не назван — заголовка нет. */
const turnHeaders = (turn: ReminderTurnKind | undefined) =>
  turn === undefined ? {} : { headers: { "x-iva-turn": turn } };

export function reminderClientOptions(
  env: NodeJS.ProcessEnv,
  turn?: ReminderTurnKind,
): ReminderClientOptions {
  const bearer = String(env.ASSISTANT_BEARER ?? "").trim();
  if (!bearer) throw new Error("ASSISTANT_BEARER is missing — run: iva doctor");
  const port = env.IVA_PORT ?? "8723";
  const host = env.ASSISTANT_HOST ?? `http://127.0.0.1:${port}`;
  return {
    host,
    auth: { bearer: () => Promise.resolve(bearer) },
    ...turnHeaders(turn),
  };
}

export type TurnStreamEvent = {
  readonly type: string;
  readonly data?: unknown;
};

/** Ответ хода: события сессии и её идентификатор — по нему её гасит стоп из чата. */
type TurnResponse = AsyncIterable<TurnStreamEvent> & {
  cancel(): Promise<unknown>;
  readonly sessionId: string;
};

export type ReminderClient = {
  readonly sessions: {
    create(input: { readonly message: string }): Promise<{
      readonly response: TurnResponse;
      readonly session: {
        send(message: string): Promise<unknown>;
        /** Остановка хода сессии вместе с порождёнными им задачами (session.cancel у eve). */
        cancel(options: { readonly tasks: boolean }): Promise<unknown>;
        reset(options: { readonly reason: string }): Promise<unknown>;
      };
    }>;
  };
};

export type CreateClient = (
  options: ReminderClientOptions,
) => Promise<ReminderClient>;

export type ReminderTurn = {
  readonly status: "completed" | "failed" | "waiting";
  /** Ход погашен снаружи (⏹ или /stop): текста от него не ждут. */
  readonly cancelled?: boolean;
  /**
   * Ход упёрся в лимит токенов сессии eve и встал на вопрос «Approve/Stop», который в фоне
   * некому показать: status "failed", message — причина, а не промежуточный текст хода.
   */
  readonly sessionLimit?: boolean;
  readonly message?: string;
  readonly feedback: (message: string) => Promise<unknown>;
};

export class ReminderTurnError extends Error {}

/** Причина провала хода, который встал на запрос лимита сессии eve. */
const SESSION_LIMIT_FAILURE = "the turn hit the eve session token limit";

// Сколько ждать ответа eve на остановку хода, вставшего на лимит: ответ не пришёл — ход
// всё равно провален, а сессию снимает reset.
const SESSION_LIMIT_CANCEL_MS = 30_000;

/**
 * Присмотр чата за ходом: пока запись есть, `/stop` из этого чата гасит его сессию тем же
 * единственным путём, что и ход канала. Кнопки ⏹ у хода напоминания нет: сообщения
 * «Работаю…» он не публикует. Запись живёт в agent/lib и передаётся зависимостью: этот
 * модуль обязан грузиться и на установке без agent/ (`iva remind`), поэтому ни одного
 * статического импорта оттуда у него нет.
 */
export type TurnWatch = {
  /** Забрать чат под ход: false — чат занят живым чужим ходом, запись не тронута. */
  claim(sessionId: string): Promise<boolean>;
  /** Пульс живого хода; чужой записи не касается. */
  pulse(sessionId: string): void;
  /** Снять запись, если она всё ещё наша. */
  release(sessionId: string): void;
};

// Three minutes without a single stream event means the turn is stuck. A turn that keeps
// sending events is working: it runs as long as the work takes, and only the owner's stop
// or that silence ends it (решение владельца 21.09.2026 — потолков длительности нет).
export const REMINDER_TURN_INACTIVITY_MS = 180_000;

/** Заголовок промпта: номер строки и срок есть у срабатывания и нет у разового `iva remind`. */
function firedLine(fire: ReminderFire): string {
  const number = fire.id === undefined ? "" : ` #${fire.id}`;
  const due =
    fire.scheduledAt === undefined ? "" : `, due: ${fire.scheduledAt}`;
  return `Reminder${number} fired (text: ${JSON.stringify(fire.text)}${due}).`;
}

export type ReminderFire = {
  /** Номер строки напоминания; разовое `iva remind <текст>` строки не имеет. */
  readonly id?: string;
  readonly text: string;
  /** Срок в зоне владельца, как его видел пользователь. */
  readonly scheduledAt?: string;
};

/**
 * Голое QUIET — «писать не о чем» планового хода, а не текст для владельца: в любом регистре, в
 * пробелах и невидимых пробелах, в кавычках, звёздочках или с точкой.
 */
export function isQuietReply(text: string): boolean {
  return /^[\s\u200B-\u200D\u2060\uFEFF*_`"'«».!]*quiet[\s\u200B-\u200D\u2060\uFEFF*_`"'«».!]*$/iu.test(
    text,
  );
}

/**
 * Промпт срабатывания: текст напоминания — инструкция самой себе, и в срок агент выполняет
 * её свежей сессией с инструментами. Финальный текст хода отправляет код, поэтому промпт
 * запрещает отправлять что-либо самому и ставить новые напоминания этим же ходом.
 */
export function reminderPrompt(
  fire: ReminderFire,
  tr: (en: string, ru: string) => string,
): string {
  return (
    `${firedLine(fire)} ` +
    "Do what it says, with your tools, and return the result as the final text of this turn: " +
    "the code will send that text to the chat where the reminder was asked for. " +
    "If it is a plain reminder with nothing to do, return the short reminder text. " +
    "If it checks a long-running background job, load the background-check skill " +
    "and return a bounded status snapshot instead of waiting for the job to finish. " +
    "The answer is never empty. " +
    `Write it ${writtenInLanguage(tr)}. ` +
    "Do not send anything yourself: no rich messages and no Telegram tools. " +
    'Do not set new reminders in this turn (remind {action: "add"} is forbidden); ' +
    "list and remove are allowed."
  );
}

type TurnState = {
  readonly status: "completed" | "failed" | "waiting" | undefined;
  readonly message: string | undefined;
  readonly failure: string | undefined;
  readonly cancelled: boolean;
  /** Ход встал на запрос лимита сессии eve (input.requested kind "session-limit"). */
  readonly sessionLimit: boolean;
};

const EMPTY_TURN: TurnState = {
  status: undefined,
  message: undefined,
  failure: undefined,
  cancelled: false,
  sessionLimit: false,
};

// eve carries the text under `data.message` in message.completed, session.failed and
// turn.failed; anything else changes nothing.
function eventText(event: TurnStreamEvent): string | undefined {
  const data = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const text = (data as { readonly message?: unknown }).message;
  return typeof text === "string" ? text : undefined;
}

// eve паркует ход на лимите сессии запросом ввода kind "session-limit"
// (eve/dist/src/harness/session-limit-continuation.js); остальные запросы не про лимит.
function asksSessionLimit(event: TurnStreamEvent): boolean {
  const data = event.data;
  if (typeof data !== "object" || data === null) return false;
  const requests = (data as { readonly requests?: unknown }).requests;
  return (
    Array.isArray(requests) &&
    requests.some(
      (request: unknown) =>
        typeof request === "object" &&
        request !== null &&
        (request as { readonly kind?: unknown }).kind === "session-limit",
    )
  );
}

// Метки хода: отмена снаружи, причина провала шага и вопрос лимита сессии. Отмена и лимит
// липкие: поздние и повторные события их не снимают.
function applyTurnMark(state: TurnState, event: TurnStreamEvent): TurnState {
  switch (event.type) {
    case "input.requested":
      return asksSessionLimit(event) ? { ...state, sessionLimit: true } : state;
    // Гасят ход снаружи (⏹, /stop): eve всегда доводит такой ход до session.waiting, но
    // для вызывающего это не «ход поработал и припарковался», а отмена.
    case "turn.cancelled":
      return { ...state, cancelled: true };
    case "turn.failed": {
      const failure = eventText(event);
      return failure === undefined ? state : { ...state, failure };
    }
    default:
      return state;
  }
}

function applyTurnEvent(state: TurnState, event: TurnStreamEvent): TurnState {
  switch (event.type) {
    case "message.completed": {
      const message = eventText(event);
      return message === undefined ? state : { ...state, message };
    }
    case "session.failed": {
      const message = eventText(event);
      return {
        ...state,
        status: "failed",
        ...(message === undefined ? {} : { message }),
      };
    }
    case "session.completed":
      return { ...state, status: "completed" };
    case "session.waiting":
      return { ...state, status: "waiting" };
    default:
      return applyTurnMark(state, event);
  }
}

/** The boundary status and the last text of an event stream, ignoring anything in between. */
export function reduceTurnEvents(
  events: readonly TurnStreamEvent[],
): TurnState {
  return events.reduce(applyTurnEvent, EMPTY_TURN);
}

type Stall = { readonly stalled: Promise<never>; readonly stop: () => void };

// A stalled turn is a turn with no events: the idle window measures the gap since the last
// event and loses the race to the stream. Ход, который шлёт события, не режется ничем:
// потолка длительности у него нет.
function stallAfter(ms: number, reason: string): Stall {
  let timer: NodeJS.Timeout | undefined;
  return {
    stalled: new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ReminderTurnError(reason)), ms);
    }),
    stop: () => {
      clearTimeout(timer);
    },
  };
}

async function defaultCreateClient(
  options: ReminderClientOptions,
): Promise<ReminderClient> {
  const { Client } = await import("eve/client");
  return new Client(options);
}

/** Сторож сработал: ход гасится у клиента до того, как отказ увидит вызывающий. */
async function cancelStalled(
  response: TurnResponse,
  log: (...args: unknown[]) => void,
): Promise<void> {
  try {
    await response.cancel();
  } catch (cancelError) {
    log("remind: turn cancel failed:", cancelError);
  }
}

/**
 * Чтение стрима хода: сторож тишины взводится заново на каждое событие, поэтому ход,
 * который работает, не кончается никогда; конец — только собственная граница потока.
 */
async function readTurnStream(
  response: TurnResponse,
  {
    inactivityMs,
    log,
    onEvent,
  }: {
    readonly inactivityMs: number;
    readonly log: (...args: unknown[]) => void;
    readonly onEvent?: () => void;
  },
): Promise<TurnState> {
  const stream = response[Symbol.asyncIterator]();
  let state = EMPTY_TURN;
  for (;;) {
    const idle = stallAfter(inactivityMs, `no activity for ${inactivityMs}ms`);
    let step: IteratorResult<TurnStreamEvent>;
    try {
      step = await Promise.race([stream.next(), idle.stalled]);
    } catch (error) {
      if (error instanceof ReminderTurnError)
        await cancelStalled(response, log);
      // Отменённый ход остаётся отменённым при любом окончании стрима: на броске признак
      // отмены терять нельзя, иначе владельцу уйдёт текст, который он остановил.
      if (state.cancelled) return state;
      throw error;
    } finally {
      idle.stop();
    }
    if (step.done) return state;
    state = applyTurnEvent(state, step.value);
    if (onEvent) onEvent();
    // Вопрос лимита в фоне некому показать: дальше читать нечего, ход останавливает
    // вызывающий, а стрим отпускается без ожидания.
    if (state.sessionLimit) {
      stream.return?.().catch(() => {});
      return state;
    }
  }
}

/**
 * Ход под присмотром чата, куда вернётся ответ: запись о сессии живёт ровно столько,
 * сколько идёт ход, и снимается на любом его исходе — по ней работает стоп из чата.
 * Чат, занятый чужим живым ходом, не трогаем вовсе: ход идёт без присмотра, а стоп
 * владельца продолжает видеть его же сессию.
 */
async function readWatchedTurn(
  response: TurnResponse,
  {
    watch,
    inactivityMs,
    log,
  }: {
    readonly watch?: TurnWatch;
    readonly inactivityMs: number;
    readonly log: (...args: unknown[]) => void;
  },
): Promise<TurnState> {
  if (watch === undefined)
    return readTurnStream(response, { inactivityMs, log });
  const sessionId = response.sessionId;
  const claimed = await watch.claim(sessionId);
  try {
    return await readTurnStream(response, {
      inactivityMs,
      log,
      onEvent: claimed ? () => watch.pulse(sessionId) : undefined,
    });
  } finally {
    if (claimed) watch.release(sessionId);
  }
}

/**
 * Граница хода. Отменённый ход отдаётся отменой и без границы сессии: eve штатно доводит
 * его до session.waiting, но потерять признак отмены нельзя — иначе код отправит владельцу
 * дословный текст напоминания, чего он не просил.
 */
function turnBoundary(state: TurnState): {
  readonly status: ReminderTurn["status"];
  readonly cancelled: boolean;
} {
  if (state.status !== undefined)
    return { status: state.status, cancelled: state.cancelled };
  if (state.cancelled) return { status: "waiting", cancelled: true };
  throw new ReminderTurnError("stream ended without a session boundary");
}

/** Ответ eve на остановку или сброс — не дольше SESSION_LIMIT_CANCEL_MS, иначе отказ. */
async function answeredInTime(work: Promise<unknown>, what: string) {
  const deadline = stallAfter(
    SESSION_LIMIT_CANCEL_MS,
    `${what} timed out after ${SESSION_LIMIT_CANCEL_MS}ms`,
  );
  try {
    await Promise.race([work, deadline.stalled]);
  } finally {
    deadline.stop();
  }
}

/**
 * Ход встал на лимит сессии или кончился по сроку: он гасится `session.cancel` с задачами,
 * чтобы порождённая им задача не работала дальше. Отказ остановки ход не спасает, он виден в
 * журнале; `why` отличает его от отмены у клиента (cancelStalled).
 */
async function stopParkedTurn(
  session: { cancel(options: { readonly tasks: boolean }): Promise<unknown> },
  log: (...args: unknown[]) => void,
  why: "session-limit" | "deadline",
): Promise<void> {
  try {
    await answeredInTime(session.cancel({ tasks: true }), "cancel");
  } catch (error) {
    log(`remind: ${why} turn cancel failed:`, error);
  }
}

/** Ход, вставший на лимит сессии, — провал с причиной; промежуточный текст не отдаётся. */
function limitedTurn(feedback: ReminderTurn["feedback"]): ReminderTurn {
  return {
    status: "failed",
    cancelled: false,
    sessionLimit: true,
    message: SESSION_LIMIT_FAILURE,
    feedback,
  };
}

/** Причина провала хода, не уложившегося в срок прогона. */
const DEADLINE_FAILURE = "the turn ran past its deadline";

/** Ход, кончившийся по сроку, — провал с причиной; текст хода не отдаётся. */
const deadlineTurn = (feedback: ReminderTurn["feedback"]): ReminderTurn => ({
  status: "failed",
  cancelled: false,
  message: DEADLINE_FAILURE,
  feedback,
});

const noFeedback: ReminderTurn["feedback"] = () => Promise.resolve();

const ABORTED = Symbol("aborted");

/** Снят ли сигнал сейчас; сигнала нет — нет. */
const isAborted = (signal: AbortSignal | undefined) => signal?.aborted === true;

/**
 * Снятие сигнала одним промисом, созданным до первого запроса хода. Событие abort приходит
 * один раз: слушатель, повешенный позже, уже снятого сигнала не увидит, поэтому промис берёт и
 * `aborted`, и событие. Без сигнала промис не разрешается никогда.
 */
function abortedBy(signal: AbortSignal | undefined): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve(ABORTED);
    else
      signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}

type Created = Awaited<ReturnType<ReminderClient["sessions"]["create"]>>;
type Session = Created["session"];

/** Сброс сессии; после срока он ждёт ответа не дольше SESSION_LIMIT_CANCEL_MS. */
async function resetSession(session: Session, late: boolean): Promise<void> {
  const reset = session.reset({ reason: "Reminder finished" });
  try {
    await (late ? answeredInTime(reset, "reset") : reset);
  } catch (error) {
    console.error("remind: session reset failed:", error);
  }
}

/**
 * Создание сессии наперегонки со сроком. Срок пришёл раньше — сессии ещё нет, null; если
 * create всё же вернулся позже, ход его сессии гасится с задачами и сессия сбрасывается.
 */
async function createBefore(
  client: ReminderClient,
  prompt: string,
  aborted: Promise<typeof ABORTED>,
  log: (...args: unknown[]) => void,
): Promise<Created | null> {
  const creating = client.sessions.create({ message: prompt });
  const first = await Promise.race([creating, aborted]);
  if (first !== ABORTED) return first;
  creating.then(
    async ({ session }) => {
      await stopParkedTurn(session, log, "deadline");
      await resetSession(session, true);
    },
    () => {},
  );
  return null;
}

/** Чтение хода наперегонки со сроком; срок уже прошёл — ход не читается. */
function readBefore(
  response: TurnResponse,
  aborted: Promise<typeof ABORTED>,
  signal: AbortSignal | undefined,
  options: Parameters<typeof readWatchedTurn>[1],
): Promise<TurnState | typeof ABORTED> {
  if (isAborted(signal)) return Promise.resolve(ABORTED);
  const reading = readWatchedTurn(response, options);
  // Проигравшее чтение может отказать позже: этот отказ уже никому не нужен.
  reading.catch(() => {});
  return Promise.race([reading, aborted]);
}

/** Исход хода: срок, вопрос лимита сессии или граница потока. */
async function settleTurn(
  state: TurnState | typeof ABORTED,
  session: Session,
  log: (...args: unknown[]) => void,
): Promise<ReminderTurn> {
  const feedback = (message: string) => session.send(message);
  if (state === ABORTED) {
    await stopParkedTurn(session, log, "deadline");
    return deadlineTurn(feedback);
  }
  if (state.sessionLimit && !state.cancelled) {
    await stopParkedTurn(session, log, "session-limit");
    return limitedTurn(feedback);
  }
  const { status, cancelled } = turnBoundary(state);
  return {
    status,
    cancelled,
    ...(state.message === undefined ? {} : { message: state.message }),
    feedback,
  };
}

type TurnDeps = {
  readonly createClient?: CreateClient;
  readonly inactivityMs?: number;
  /** Присмотр чата за ходом: без него ход идёт без записи (так его зовёт CLI). */
  readonly watch?: TurnWatch;
  readonly log?: (...args: unknown[]) => void;
  /**
   * Срок хода: снятый сигнал гасит ход на сервере с задачами. Без сигнала срока нет — так
   * ходят напоминания (решение владельца 21.09.2026); сигнал передаёт только тик proactive.
   */
  readonly signal?: AbortSignal;
};

const withDefaults = (deps: TurnDeps) => ({
  createClient: deps.createClient ?? defaultCreateClient,
  inactivityMs: deps.inactivityMs ?? REMINDER_TURN_INACTIVITY_MS,
  log: deps.log ?? console.error,
});

export async function runReminderTurn(
  prompt: string,
  options: ReminderClientOptions,
  deps: TurnDeps = {},
): Promise<ReminderTurn> {
  const { createClient, inactivityMs, log } = withDefaults(deps);
  const { signal, watch } = deps;
  if (isAborted(signal)) return deadlineTurn(noFeedback);
  const aborted = abortedBy(signal);
  const client = await createClient(options);
  let session: Session | undefined;
  try {
    const created = await createBefore(client, prompt, aborted, log);
    if (created === null) return deadlineTurn(noFeedback);
    session = created.session;
    const state = await readBefore(created.response, aborted, signal, {
      watch,
      inactivityMs,
      log,
    });
    return await settleTurn(state, created.session, log);
  } finally {
    if (session) await resetSession(session, isAborted(signal));
  }
}
