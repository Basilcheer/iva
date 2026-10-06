import { randomUUID } from "node:crypto";
import { traceContextParts, traceTurnBound } from "./trace.ts";
import { localStamp } from "./vault-daily.ts";
import { resolveVaultDir } from "@iva/vault-dir";
import { QUEUED_STATUS_CLEARED } from "./run-status.ts";

type ChatStatus = Record<string, unknown> | null;
type GetStatus = (chatKey: string) => ChatStatus;
type SetStatusIf = (
  chatKey: string,
  expected: Record<string, unknown>,
  patch: Record<string, unknown>,
  options?: { touch?: boolean },
) => unknown;

export interface PublishTelegramEarlyStatusOptions {
  chatKey: string;
  ingressId?: string;
  now?: () => number;
  staleMs?: number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  sendWorkingStatusImpl: (options: {
    canStop: false;
  }) => Promise<number | null | undefined>;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export interface PublishTelegramTurnStartedOptions {
  chatKey: string;
  sessionId: string;
  turnId: string;
  now?: () => number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  sendWorkingStatusImpl?: (options: {
    canStop: true;
  }) => Promise<number | null | undefined>;
  enableWorkingStatusStopImpl?: (messageId: number) => Promise<unknown>;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export interface AbandonTelegramEarlyStatusOptions {
  chatKey: string;
  ingressId: string;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export interface EmitTelegramTurnLatencyOptions {
  chatKey: string;
  sessionId: string;
  deliveryAt: number;
  delivered: boolean;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  logImpl?: (line: string) => void;
}

export interface MarkTelegramFirstOutputOptions {
  chatKey: string;
  sessionId: string;
  now?: () => number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
}

export interface MarkTelegramTurnAliveOptions {
  chatKey: string;
  sessionId: string;
  now?: () => number;
  minIntervalMs?: number;
  beats?: Map<string, TurnHeartbeat>;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
}

export type TurnHeartbeat = { sessionId: string; at: number };

export interface TakeOverTelegramChatOptions {
  chatKey: string;
  /** Что записать в освободившийся чат: chatTakeOverPatch(...) плюс поля своего хода. */
  patch: Record<string, unknown>;
  now?: () => number;
  staleMs?: number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  /** Уборка осиротевшего индикатора «Работаю…»; у кого нет своего Bot API-шва — no-op. */
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
  /** Запись, которую этот претендент не берёт вовсе; смотрится тем же чтением, что и CAS. */
  refuseImpl?: (status: ChatStatus) => boolean;
}

/**
 * Что записать в чат, доставшийся от мёртвого хозяина: тот же набор обнулений, что у канала,
 * плюс поля своего хода. Иначе поля протухшего хода (statusAt, firstOutputAt, latencyLogged,
 * resetAt) переезжают в запись нового хозяина и врут про его сроки. Поля знака очереди
 * (queued*) патч не трогает: знак ждёт хода своего сообщения и переезжает в запись нового
 * хозяина — свёртки, напоминания, раннего статуса; забирает или удаляет его следующий ход.
 */
export function chatTakeOverPatch(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    status: "running",
    ingressId: null,
    ingressAt: null,
    statusAt: null,
    turnAt: null,
    firstOutputAt: null,
    sessionId: null,
    turnId: null,
    compacting: null,
    statusMessageId: null,
    latencyLogged: null,
    resetAt: null,
    ...fields,
  };
}

// Живой чужой ход: его индикатор уже на экране, а свой этот ход получит в turn.started.
const freshRunning = (
  status: ChatStatus,
  at: number,
  staleMs: number,
): boolean =>
  status?.status === "running" &&
  typeof status.updatedAt === "number" &&
  at - status.updatedAt < staleMs;

// Индикатор протухшей записи: после захвата его больше никто не найдёт — прибирает тот, кто взял.
const orphanWorkingStatusId = (status: ChatStatus): number | undefined =>
  status?.status === "running" && typeof status.statusMessageId === "number"
    ? status.statusMessageId
    : undefined;

/**
 * Убрать сообщение «Работаю…», за которым больше никто не следит. Сбой уборки не критичен:
 * сообщение живёт дольше, чем нужно, но состояние чата уже верно.
 */
async function dropWorkingStatus(
  messageId: number | undefined,
  remove: ((messageId: number) => Promise<unknown>) | undefined,
  onError: (error: unknown) => void = () => {},
): Promise<void> {
  if (messageId === undefined) return;
  try {
    await remove?.(messageId);
  } catch (error) {
    onError(error);
  }
}

/** Всё, что нужно одной попытке клейма. */
type ClaimStep = {
  readonly chatKey: string;
  readonly patch: Record<string, unknown>;
  readonly at: number;
  readonly staleMs: number;
  readonly getStatusImpl: GetStatus;
  readonly setStatusIfImpl: SetStatusIf;
  readonly refuseImpl?: (status: ChatStatus) => boolean;
};

/** Попытка ровно одна: занятый чат — сразу нет, проигранный CAS — повод повторить. */
function claimOnce(step: ClaimStep): {
  readonly taken: boolean;
  readonly live: boolean;
  readonly orphanMessageId?: number;
} {
  const current = step.getStatusImpl(step.chatKey);
  if (
    freshRunning(current, step.at, step.staleMs) ||
    step.refuseImpl?.(current)
  )
    return { taken: false, live: true };
  const claimed = step.setStatusIfImpl(
    step.chatKey,
    { generation: current?.generation },
    step.patch,
  );
  return claimed
    ? {
        taken: true,
        live: false,
        orphanMessageId: orphanWorkingStatusId(current),
      }
    : { taken: false, live: false };
}

/**
 * Взять чат у осиротевшей записи — один путь на канал и на ход напоминания
 * (scripts/reminders/fire.ts), второй копии клейма в репозитории нет. Живой чужой ход не
 * трогаем вовсе: false — чат занят, запись не тронута. Клейм — CAS по generation, чтобы
 * конкурирующий претендент не украл состояние между read и write.
 */
export async function takeOverTelegramChat(
  options: TakeOverTelegramChatOptions,
): Promise<boolean> {
  return (await claimChat(options)) === "taken";
}

/** Исход клейма: чат взят, занят живым ходом или CAS проигран трижды (сбой чтения тоже). */
async function claimChat({
  chatKey,
  patch,
  now,
  staleMs,
  getStatusImpl,
  setStatusIfImpl,
  removeWorkingStatusImpl,
  onWorkingStatusError,
  refuseImpl,
}: TakeOverTelegramChatOptions): Promise<"taken" | "live" | "lost"> {
  const step: ClaimStep = {
    chatKey,
    patch,
    at: (now ?? Date.now)(),
    staleMs: staleMs ?? 30 * 60_000,
    getStatusImpl,
    setStatusIfImpl,
    refuseImpl,
  };
  const onError = onWorkingStatusError ?? (() => {});
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { taken, live, orphanMessageId } = claimOnce(step);
      if (live) return "live";
      if (!taken) continue;
      await dropWorkingStatus(
        orphanMessageId,
        removeWorkingStatusImpl,
        onError,
      );
      return "taken";
    }
  } catch (error) {
    onError(error);
  }
  return "lost";
}

// Пульс живого хода. Жнец моста (scripts/poller/queue.ts) считает ход мёртвым по
// возрасту updatedAt, а тот двигался только на старте хода, первом выводе и финале:
// молчаливый ход на сорок минут (глубокий ресёрч) получал насильный idle, реальный
// сброс континуации и ложь «ход оборвался» — при живом ходе. Теперь ход сам
// подтверждает, что жив, из своих же событий.
//
// Дёшево: события идут пачками, поэтому запись в run-status дросселируется одной на
// интервал и делается CAS-ом по sessionId — опоздавший пульс не воскресит уже
// завершённый или сброшенный ход. Карта пульсов ключуется чатом, не сессией, поэтому
// не растёт с числом ходов.
export const TURN_HEARTBEAT_MIN_INTERVAL_MS = 60_000;
const turnHeartbeats = new Map<string, TurnHeartbeat>();

const durationFromIngress = (ingressAt: unknown, at: unknown): number | null =>
  typeof ingressAt === "number" &&
  Number.isFinite(ingressAt) &&
  typeof at === "number" &&
  Number.isFinite(at) &&
  at >= ingressAt
    ? at - ingressAt
    : null;

/**
 * Индикатор раннего статуса: отправить и привязать к записи. Запись могла уйти между
 * отправкой и привязкой (reset, чужой ход) — сообщение, за которым никто не следит,
 * прибираем сами; сбой отправки только журналируется, ход он не останавливает.
 */
async function sendEarlyStatus({
  chatKey,
  ingressId,
  now,
  setStatusIfImpl,
  sendWorkingStatusImpl,
  removeWorkingStatusImpl,
  onWorkingStatusError,
}: {
  readonly chatKey: string;
  readonly ingressId: string;
  readonly now: () => number;
  readonly setStatusIfImpl: SetStatusIf;
  readonly sendWorkingStatusImpl: (options: {
    canStop: false;
  }) => Promise<number | null | undefined>;
  readonly removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  readonly onWorkingStatusError?: (error: unknown) => void;
}): Promise<void> {
  let statusMessageId;
  try {
    statusMessageId = await sendWorkingStatusImpl({ canStop: false });
  } catch (error) {
    onWorkingStatusError?.(error);
    return;
  }
  if (statusMessageId === null || statusMessageId === undefined) return;

  const attached = setStatusIfImpl(
    chatKey,
    { status: "running", ingressId },
    { statusMessageId, statusAt: now() },
  );
  if (!attached)
    await dropWorkingStatus(
      statusMessageId,
      removeWorkingStatusImpl,
      onWorkingStatusError,
    );
}

/**
 * Знак сообщению, вставшему в очередь за живым ходом: тот же лоадер, что у раннего
 * статуса, без кнопки — ход этого сообщения ещё не начался. Знак один на чат и живёт в
 * записи чата полями queued*: чьё сообщение (queuedIngressId), за ходом какой сессии оно
 * встало (queuedSessionId), когда пришло и когда появился знак. Запись знака updatedAt не
 * двигает: она не говорит, что живой ход жив.
 */
async function sendQueuedStatus({
  chatKey,
  ingressId,
  ingressAt,
  now,
  staleMs,
  getStatusImpl,
  setStatusIfImpl,
  sendWorkingStatusImpl,
  removeWorkingStatusImpl,
  onWorkingStatusError,
}: {
  readonly chatKey: string;
  readonly ingressId: string;
  readonly ingressAt: number;
  readonly now: () => number;
  readonly staleMs: number;
  readonly getStatusImpl: GetStatus;
  readonly setStatusIfImpl: SetStatusIf;
  readonly sendWorkingStatusImpl: (options: {
    canStop: false;
  }) => Promise<number | null | undefined>;
  readonly removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  readonly onWorkingStatusError?: (error: unknown) => void;
}): Promise<void> {
  // Знак один на чат и только за живым ходом; место под него занимается CAS-ом, чтобы
  // знак другого сообщения, поставленный после чтения, не был перезаписан.
  const holdQueuedSign = (current: ChatStatus): boolean =>
    freshRunning(current, ingressAt, staleMs) &&
    current?.queuedIngressId === undefined &&
    Boolean(
      setStatusIfImpl(
        chatKey,
        { status: "running", queuedIngressId: undefined },
        {
          queuedIngressId: ingressId,
          queuedIngressAt: ingressAt,
          queuedSessionId: sessionIdOf(current),
        },
        { touch: false },
      ),
    );
  try {
    if (!holdQueuedSign(getStatusImpl(chatKey))) return;
    const messageId = await sendWorkingStatusImpl({ canStop: false });
    if (messageId === null || messageId === undefined) return;
    const attached = setStatusIfImpl(
      chatKey,
      { queuedIngressId: ingressId },
      { queuedStatusMessageId: messageId, queuedStatusAt: now() },
      { touch: false },
    );
    if (!attached)
      await dropWorkingStatus(
        messageId,
        removeWorkingStatusImpl,
        onWorkingStatusError,
      );
  } catch (error) {
    onWorkingStatusError?.(error);
  }
}

const sessionIdOf = (current: ChatStatus): string | null =>
  typeof current?.sessionId === "string" ? current.sessionId : null;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Знак очереди глазами начавшегося хода. Буфер входа eve уходит в один ход, поэтому
 * сообщение знака либо в этом ходе, либо уже не придёт: ход знак забирает всегда. Ход
 * сессии, за которой знак встал, берёт его себе статусом вместе со временем прихода и
 * знака (так считается ingressToStatusMs); любой другой ход знак удаляет и времени
 * чужого сообщения не наследует.
 */
function queuedStatusOf(
  current: ChatStatus,
  sessionId: string,
): {
  readonly fields: Record<string, unknown>;
  readonly messageId?: number;
  readonly own: boolean;
} {
  if (current?.queuedIngressId === undefined) return { fields: {}, own: false };
  const own = current.queuedSessionId === sessionId;
  return {
    fields: {
      ...QUEUED_STATUS_CLEARED,
      ...(own
        ? {
            ingressAt: finiteNumber(current.queuedIngressAt) ?? null,
            statusAt: finiteNumber(current.queuedStatusAt) ?? null,
          }
        : {}),
    },
    messageId: finiteNumber(current.queuedStatusMessageId),
    own,
  };
}

export interface DropQueuedStatusOptions {
  chatKey: string;
  /** Снять только знак этого сообщения; без него — любой. */
  ingressId?: string;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

/**
 * Снять знак очереди из записи и из чата: запись ушла без хода-наследника (сессия упала,
 * сообщение бросил inbound pipeline, ход отвергнут меткой сброса). CAS по queuedIngressId:
 * знак, поставленный после чтения, не трогается. true — знак был и снят.
 */
export async function dropQueuedStatus({
  chatKey,
  ingressId,
  getStatusImpl,
  setStatusIfImpl,
  removeWorkingStatusImpl,
  onWorkingStatusError,
}: DropQueuedStatusOptions): Promise<boolean> {
  const current = getStatusImpl(chatKey);
  const owner = current?.queuedIngressId;
  if (owner === undefined || (ingressId !== undefined && owner !== ingressId))
    return false;
  if (
    !setStatusIfImpl(
      chatKey,
      { queuedIngressId: owner },
      QUEUED_STATUS_CLEARED,
      { touch: false },
    )
  )
    return false;
  await dropWorkingStatus(
    finiteNumber(current?.queuedStatusMessageId),
    removeWorkingStatusImpl,
    onWorkingStatusError,
  );
  return true;
}

export async function publishTelegramEarlyStatus({
  chatKey,
  ingressId = randomUUID(),
  now = Date.now,
  staleMs = 30 * 60_000,
  getStatusImpl,
  setStatusIfImpl,
  sendWorkingStatusImpl,
  removeWorkingStatusImpl,
  onWorkingStatusError,
}: PublishTelegramEarlyStatusOptions): Promise<string | null> {
  const ingressAt = now();
  // Мост пропускает реплаи на сообщения бота мимо busy-очереди, поэтому сюда можно
  // попасть, пока предыдущий ход ещё бежит. Клейм общий с ходом напоминания
  // (takeOverTelegramChat): живой ход не трогаем, а сообщению, вставшему за ним в
  // очередь, сразу ставим знак (sendQueuedStatus) — иначе под ним пусто до конца
  // чужого хода. Протухшую запись забираем и прибираем осиротевший индикатор.
  const claimed = await claimChat({
    chatKey,
    patch: chatTakeOverPatch({ ingressId, ingressAt }),
    now: () => ingressAt,
    staleMs,
    getStatusImpl,
    setStatusIfImpl,
    removeWorkingStatusImpl,
    onWorkingStatusError,
  });
  if (claimed === "live")
    await sendQueuedStatus({
      chatKey,
      ingressId,
      ingressAt,
      now,
      staleMs,
      getStatusImpl,
      setStatusIfImpl,
      sendWorkingStatusImpl,
      removeWorkingStatusImpl,
      onWorkingStatusError,
    });
  if (claimed !== "taken") return null;
  await sendEarlyStatus({
    chatKey,
    ingressId,
    now,
    setStatusIfImpl,
    sendWorkingStatusImpl,
    removeWorkingStatusImpl,
    onWorkingStatusError,
  });
  return ingressId;
}

export async function publishTelegramTurnStarted({
  chatKey,
  sessionId,
  turnId,
  now = Date.now,
  getStatusImpl,
  setStatusIfImpl,
  sendWorkingStatusImpl,
  enableWorkingStatusStopImpl = async () => {},
  removeWorkingStatusImpl = async () => {},
  onWorkingStatusError = () => {},
}: PublishTelegramTurnStartedOptions): Promise<boolean> {
  // Trace: ключ апдейта ↔ ход. Единственное место, где события «до хода» (Bridge,
  // Inbound pipeline, Gate) сшиваются с событиями eve — раньше turnId не существует.
  // Рядом — состав памяти, которая уедет в системный промпт этого хода.
  traceTurnBound(chatKey, sessionId, turnId);
  traceContextParts(
    turnId,
    sessionId,
    resolveVaultDir(process.cwd()),
    localStamp().date,
  );
  const start: TurnStart = {
    chatKey,
    sessionId,
    turnId,
    now,
    setStatusIfImpl,
    sendWorkingStatusImpl,
    enableWorkingStatusStopImpl,
    removeWorkingStatusImpl,
    onWorkingStatusError,
  };
  const current = getStatusImpl(chatKey);
  return current?.status === "running" &&
    typeof current.ingressId === "string" &&
    current.ingressId.length > 0 &&
    current.sessionId === undefined
    ? adoptEarlyStatus(start, current, current.ingressId)
    : claimTurnStatus(start, current);
}

type TurnStart = Required<
  Omit<
    PublishTelegramTurnStartedOptions,
    "getStatusImpl" | "sendWorkingStatusImpl"
  >
> &
  Pick<PublishTelegramTurnStartedOptions, "sendWorkingStatusImpl">;

async function enableStop(start: TurnStart, messageId: number): Promise<void> {
  try {
    await start.enableWorkingStatusStopImpl(messageId);
  } catch (error) {
    start.onWorkingStatusError(error);
  }
}

// Ход с ранним статусом (сообщение прошло onMessage на свободный чат): забрать запись и
// дорисовать кнопку в тот же статус. Знак очереди уходит: его сообщение в этом же ходе
// (буфер входа eve уходит в один ход) или придёт своим ходом со своим статусом.
async function adoptEarlyStatus(
  start: TurnStart,
  current: Record<string, unknown>,
  ingressId: string,
): Promise<boolean> {
  const queued = queuedStatusOf(current, start.sessionId);
  try {
    const adopted = start.setStatusIfImpl(
      start.chatKey,
      { status: "running", ingressId, sessionId: undefined },
      {
        sessionId: start.sessionId,
        turnId: start.turnId,
        turnAt: start.now(),
        ...(queued.messageId === undefined ? {} : QUEUED_STATUS_CLEARED),
      },
    );
    if (!adopted) return false;
    await dropWorkingStatus(
      queued.messageId,
      start.removeWorkingStatusImpl,
      start.onWorkingStatusError,
    );
    if (current.statusMessageId !== undefined)
      await enableStop(start, current.statusMessageId as number);
    return true;
  } catch (error) {
    start.onWorkingStatusError(error);
    return false;
  }
}

// Callback/HITL, proactive turns and messages queued behind a live turn do not get an
// early status of their own. Preserve their status behavior with a generation CAS, while
// a reset tombstone always wins over a late old turn (and takes the queued sign down: a
// reset left no turn for it). The sign put up behind this session's turn becomes this
// turn's status with its ingress and status time; any other sign is deleted after this
// turn's own status is up.
async function claimTurnStatus(
  start: TurnStart,
  current: ChatStatus,
): Promise<boolean> {
  if (current?.resetAt !== undefined) {
    await dropQueuedStatus({ ...start, getStatusImpl: () => current });
    return false;
  }
  const queued = queuedStatusOf(current, start.sessionId);
  const sign = queued.own ? queued.messageId : undefined;
  let claimed;
  try {
    claimed = start.setStatusIfImpl(
      start.chatKey,
      { generation: current?.generation },
      {
        status: "running",
        sessionId: start.sessionId,
        turnId: start.turnId,
        compacting: null,
        statusMessageId: sign ?? null,
        turnAt: start.now(),
        latencyLogged: null,
        ...queued.fields,
      },
    );
  } catch (error) {
    start.onWorkingStatusError(error);
    return false;
  }
  if (!claimed) return false;
  await showTurnStatus(start, queued);
  return true;
}

// Статус взятого хода: свой знак очереди с дорисованной кнопкой или свежий «Работаю…», и
// только потом снять чужой знак — под сообщением ни на миг не пусто.
async function showTurnStatus(
  start: TurnStart,
  queued: ReturnType<typeof queuedStatusOf>,
): Promise<void> {
  const sign = queued.own ? queued.messageId : undefined;
  if (sign !== undefined) await enableStop(start, sign);
  else if (start.sendWorkingStatusImpl !== undefined)
    await sendTurnStatus(start, start.sendWorkingStatusImpl, queued.own);
  if (!queued.own)
    await dropWorkingStatus(
      queued.messageId,
      start.removeWorkingStatusImpl,
      start.onWorkingStatusError,
    );
}

async function sendTurnStatus(
  start: TurnStart,
  send: NonNullable<TurnStart["sendWorkingStatusImpl"]>,
  stampStatus: boolean,
): Promise<void> {
  let statusMessageId;
  try {
    statusMessageId = await send({ canStop: true });
  } catch (error) {
    start.onWorkingStatusError(error);
    return;
  }
  if (statusMessageId === null || statusMessageId === undefined) return;
  const attached = start.setStatusIfImpl(
    start.chatKey,
    { status: "running", sessionId: start.sessionId, turnId: start.turnId },
    { statusMessageId, ...(stampStatus ? { statusAt: start.now() } : {}) },
  );
  if (!attached)
    await dropWorkingStatus(
      statusMessageId,
      start.removeWorkingStatusImpl,
      start.onWorkingStatusError,
    );
}

// Сообщение бросил inbound pipeline: снять его индикатор — ранний статус свободного чата
// или знак очереди за живым ходом.
export async function abandonTelegramEarlyStatus(
  options: AbandonTelegramEarlyStatusOptions,
): Promise<boolean> {
  return (await dropQueuedStatus(options)) || abandonOwnEarlyStatus(options);
}

async function abandonOwnEarlyStatus({
  chatKey,
  ingressId,
  getStatusImpl,
  setStatusIfImpl,
  removeWorkingStatusImpl = async () => {},
  onWorkingStatusError = () => {},
}: AbandonTelegramEarlyStatusOptions): Promise<boolean> {
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    current.ingressId !== ingressId ||
    current.sessionId !== undefined
  ) {
    return false;
  }
  const cleared = setStatusIfImpl(
    chatKey,
    { status: "running", ingressId, sessionId: undefined },
    {
      status: "idle",
      ingressId: null,
      ingressAt: null,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      statusMessageId: null,
      latencyLogged: null,
    },
  );
  if (!cleared) return false;
  if (current.statusMessageId !== undefined) {
    try {
      await removeWorkingStatusImpl(current.statusMessageId as number);
    } catch (error) {
      onWorkingStatusError(error);
    }
  }
  return true;
}

export function markTelegramFirstOutput({
  chatKey,
  sessionId,
  now = Date.now,
  getStatusImpl,
  setStatusIfImpl,
}: MarkTelegramFirstOutputOptions): boolean {
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    current.sessionId !== sessionId ||
    current.firstOutputAt !== undefined
  ) {
    return false;
  }
  return Boolean(
    setStatusIfImpl(
      chatKey,
      { status: "running", sessionId, firstOutputAt: undefined },
      { firstOutputAt: now() },
    ),
  );
}

export function markTelegramTurnAlive({
  chatKey,
  sessionId,
  now = Date.now,
  minIntervalMs = TURN_HEARTBEAT_MIN_INTERVAL_MS,
  beats = turnHeartbeats,
  getStatusImpl,
  setStatusIfImpl,
}: MarkTelegramTurnAliveOptions): boolean {
  const at = now();
  const previous = beats.get(chatKey);
  if (previous?.sessionId === sessionId && at - previous.at < minIntervalMs)
    return false;
  const current = getStatusImpl(chatKey);
  if (current?.status !== "running" || current.sessionId !== sessionId) {
    // Ход этого чата уже не наш: пульс не пишем и забываем его отметку.
    if (previous !== undefined) beats.delete(chatKey);
    return false;
  }
  // Отметку ставим до записи: сбойный CAS не должен превращать поток событий в
  // поток попыток записи. Следующая попытка всё равно придёт через интервал.
  beats.set(chatKey, { sessionId, at });
  // Патч пустой намеренно: пульсу нечего сообщать, кроме «я жив», а любая успешная
  // запись run-status двигает updatedAt (agent/lib/run-status.ts). Отдельное поле
  // дублировало бы updatedAt и требовало уборки в каждом терминальном патче.
  return Boolean(
    setStatusIfImpl(chatKey, { status: "running", sessionId }, {}),
  );
}

export function emitTelegramTurnLatency({
  chatKey,
  sessionId,
  deliveryAt,
  delivered,
  getStatusImpl,
  setStatusIfImpl,
  logImpl = console.log,
}: EmitTelegramTurnLatencyOptions): boolean {
  if (delivered !== true) return false;
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    current.sessionId !== sessionId ||
    current.latencyLogged !== undefined
  ) {
    return false;
  }
  const marked = setStatusIfImpl(
    chatKey,
    { status: "running", sessionId, latencyLogged: undefined },
    { latencyLogged: true },
  );
  if (!marked) return false;

  const record = {
    event: "telegram_turn_latency",
    ingressToStatusMs: durationFromIngress(current.ingressAt, current.statusAt),
    ingressToTurnMs: durationFromIngress(current.ingressAt, current.turnAt),
    ingressToFirstOutputMs: durationFromIngress(
      current.ingressAt,
      current.firstOutputAt,
    ),
    ingressToDeliveryMs: durationFromIngress(current.ingressAt, deliveryAt),
  };
  logImpl(JSON.stringify(record));
  return true;
}
