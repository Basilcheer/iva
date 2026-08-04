import { randomUUID } from "node:crypto";
import { toChannelLocalToken } from "#lib/telegram-continuation-token.mjs";

const durationFromIngress = (ingressAt, at) =>
  Number.isFinite(ingressAt) && Number.isFinite(at) && at >= ingressAt
    ? at - ingressAt
    : null;

export async function publishTelegramEarlyStatus({
  chatKey,
  ingressId = randomUUID(),
  now = Date.now,
  setStatusImpl,
  setStatusIfImpl,
  sendWorkingStatusImpl,
  removeWorkingStatusImpl = async () => {},
  onWorkingStatusError = () => {},
}) {
  const ingressAt = now();
  try {
    setStatusImpl(chatKey, {
      status: "running",
      ingressId,
      ingressAt,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      sessionId: null,
      turnId: null,
      statusMessageId: null,
      latencyLogged: null,
      resetAt: null,
    });
  } catch (error) {
    onWorkingStatusError(error);
    return null;
  }

  let statusMessageId;
  try {
    statusMessageId = await sendWorkingStatusImpl({ canStop: false });
  } catch (error) {
    onWorkingStatusError(error);
    return ingressId;
  }
  if (statusMessageId === null || statusMessageId === undefined) return ingressId;

  const attached = setStatusIfImpl(
    chatKey,
    { status: "running", ingressId },
    { statusMessageId, statusAt: now() },
  );
  if (!attached) {
    try {
      await removeWorkingStatusImpl(statusMessageId);
    } catch (error) {
      onWorkingStatusError(error);
    }
  }
  return ingressId;
}

export async function publishTelegramTurnStarted({
  chatKey,
  continuationToken: rawContinuationToken,
  sessionId,
  turnId,
  now = Date.now,
  getStatusImpl,
  setStatusIfImpl,
  sendWorkingStatusImpl,
  enableWorkingStatusStopImpl = async () => {},
  removeWorkingStatusImpl = async () => {},
  onWorkingStatusError = () => {},
}) {
  // Обработчики событий eve отдают токен с именем канала впереди. В статусе он должен
  // лежать только channel-local: reset-роут клеит имя канала сам (#110).
  const continuationToken = toChannelLocalToken(rawContinuationToken);
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    typeof current.ingressId !== "string" ||
    current.ingressId.length === 0 ||
    current.sessionId !== undefined
  ) {
    // Callback/HITL and proactive turns do not pass through onMessage. Preserve
    // their existing status behavior with a generation CAS, while a reset
    // tombstone always wins over a late old turn.
    if (current?.resetAt !== undefined) return false;
    let claimed;
    try {
      claimed = setStatusIfImpl(
        chatKey,
        { generation: current?.generation },
        {
          status: "running",
          continuationToken,
          sessionId,
          turnId,
          statusMessageId: null,
          turnAt: now(),
          latencyLogged: null,
        },
      );
    } catch (error) {
      onWorkingStatusError(error);
      return false;
    }
    if (!claimed || sendWorkingStatusImpl === undefined) return Boolean(claimed);
    let statusMessageId;
    try {
      statusMessageId = await sendWorkingStatusImpl({ canStop: true });
    } catch (error) {
      onWorkingStatusError(error);
      return true;
    }
    if (statusMessageId === null || statusMessageId === undefined) return true;
    const attached = setStatusIfImpl(
      chatKey,
      { status: "running", sessionId, turnId },
      { statusMessageId },
    );
    if (!attached) {
      try {
        await removeWorkingStatusImpl(statusMessageId);
      } catch (error) {
        onWorkingStatusError(error);
      }
    }
    return true;
  }
  try {
    const adopted = setStatusIfImpl(
      chatKey,
      {
        status: "running",
        ingressId: current.ingressId,
        sessionId: undefined,
      },
      {
        continuationToken,
        sessionId,
        turnId,
        turnAt: now(),
      },
    );
    if (!adopted) return false;
    if (current.statusMessageId !== undefined) {
      try {
        await enableWorkingStatusStopImpl(current.statusMessageId);
      } catch (error) {
        onWorkingStatusError(error);
      }
    }
    return true;
  } catch (error) {
    onWorkingStatusError(error);
    return false;
  }
}

export async function abandonTelegramEarlyStatus({
  chatKey,
  ingressId,
  getStatusImpl,
  setStatusIfImpl,
  removeWorkingStatusImpl = async () => {},
  onWorkingStatusError = () => {},
}) {
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
      await removeWorkingStatusImpl(current.statusMessageId);
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
}) {
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

export function emitTelegramTurnLatency({
  chatKey,
  sessionId,
  deliveryAt,
  delivered,
  getStatusImpl,
  setStatusIfImpl,
  logImpl = console.log,
}) {
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
    ingressToFirstOutputMs: durationFromIngress(current.ingressAt, current.firstOutputAt),
    ingressToDeliveryMs: durationFromIngress(current.ingressAt, deliveryAt),
  };
  logImpl(JSON.stringify(record));
  return true;
}
