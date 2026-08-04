import { join } from "node:path";
import {
  clearQueueFileKey,
  loadQueueFile,
  writeQueueFileAtomic,
} from "../lib/telegram-queue.mjs";
import { toChannelLocalToken } from "#lib/telegram-continuation-token.mjs";
import {
  clearTelegramResetIntent,
  loadTelegramResetIntents,
  persistTelegramResetIntent,
} from "../lib/telegram-reset-intent.mjs";
import { requestTelegramReset } from "../lib/telegram-reset.mjs";
import {
  getChatStatus,
  listChatStatuses,
  RUN_STALE_MS,
  setChatStatus,
  setChatStatusIf,
} from "#lib/run-status.mjs";
import { tr } from "#lib/i18n.mjs";
import { DATA_DIR, SECRET, RESET_ROUTE, log } from "./config.mjs";
import { tg } from "./transport.mjs";

// ── Durable busy-time FIFO ──────────────────────────────────────────────────
// Each accepted Telegram update is written as a versioned item (including update_id and
// the untouched raw update) before its Telegram offset advances. The bridge then replays
// one head per idle chat/topic. It removes that head only after Eve accepts the webhook:
// a crash can duplicate the head, but cannot lose it or reorder later items around it.
const QUEUE_FILE = join(DATA_DIR, "telegram-queue.json");
const RESET_INTENT_DIR = join(DATA_DIR, "telegram-reset-intents");
const queueSettleUntil = new Map();
const queueInFlight = new Map();
const queueDrainRotation = { afterKey: null };
const undrainableLegacyLogged = new Set();
const QUEUE_DELIVERY_TIMEOUT_MS = 5_000;
const QUEUE_DRAIN_BUDGET_MS = 5_000;

function statusGeneration(status) {
  return Number.isSafeInteger(status?.generation) && status.generation >= 0
    ? status.generation
    : 0;
}

export async function loadQueue({ strict = false } = {}) {
  const loaded = await loadQueueFile(QUEUE_FILE, { strict });
  if (loaded.quarantined) {
    log(`damaged Telegram queue moved to ${loaded.quarantined}:`, loaded.error.message);
  }
  return loaded.document;
}

export async function writeQueueAtomic(queue, options = {}) {
  await writeQueueFileAtomic(QUEUE_FILE, queue, options);
}

// A scoped reset intentionally discards only messages queued for this chat/topic.
// Other conversations keep both their queues and their Eve histories.
async function clearChatQueue(chatKey) {
  // Reset cleanup must fail loudly: completeScopedResetState keeps the old
  // running status until this atomic rewrite succeeds.
  await clearQueueFileKey(QUEUE_FILE, chatKey);
}

export async function completeScopedResetState(
  chatKey,
  rawContinuationToken,
  {
    clearQueue = false,
    clearQueueImpl = clearChatQueue,
    setStatusImpl = setChatStatus,
  } = {},
) {
  // For private chats the queue belongs to the reset session, so clear it
  // before exposing an idle tombstone. A failed cleanup leaves the old running
  // status in place and lets a repeated /new retry safely.
  if (clearQueue) await clearQueueImpl(chatKey);

  // Надгробие переживает рестарты и потом уходит в reset как есть — только channel-local.
  const continuationToken = toChannelLocalToken(rawContinuationToken);

  // Keep an idle token tombstone: Telegram updates are at-least-once. If the
  // same group /new is replayed after a crash, the second reset remains an
  // idempotent no_active_session instead of losing the group anchor.
  setStatusImpl(chatKey, {
    status: "idle",
    continuationToken,
    sessionId: null,
    turnId: null,
    statusMessageId: null,
    ingressId: null,
    ingressAt: null,
    statusAt: null,
    turnAt: null,
    firstOutputAt: null,
    latencyLogged: null,
    wasCancelled: null,
    resetAt: Date.now(),
  });
}

export async function persistPrivateResetIntent(chatKey, continuationToken) {
  return persistTelegramResetIntent(RESET_INTENT_DIR, chatKey, continuationToken);
}

export async function loadPrivateResetIntents() {
  return loadTelegramResetIntents(RESET_INTENT_DIR);
}

export async function clearPrivateResetIntent(chatKey) {
  return clearTelegramResetIntent(RESET_INTENT_DIR, chatKey);
}

const requestResetFromIntent = ({ continuationToken }) =>
  requestTelegramReset({
    url: RESET_ROUTE,
    secret: SECRET,
    continuationToken,
  });

export async function releaseScopedContinuation(
  chatKey,
  continuationToken,
  { requestResetImpl = requestResetFromIntent, logImpl = log } = {},
) {
  // Наружу уходит только channel-local токен: reset-роут клеит имя канала сам (#110).
  const token = toChannelLocalToken(continuationToken);
  let result;
  try {
    result = await requestResetImpl({ chatKey, continuationToken: token });
  } catch (error) {
    error.resetPhase = "remote";
    throw error;
  }
  // Ответ no_active_session идемпотентен и для реплея апдейта нормален, но именно он
  // маскировал #110: сброс «удавался», ничего не сбрасывая. В журнале исход виден.
  logResetOutcome(logImpl, chatKey, token, result);
  return result;
}

function logResetOutcome(logImpl, chatKey, continuationToken, result) {
  try {
    // chatKey сам оканчивается двоеточием (chat:topic) — отделяем явным словом, иначе
    // строка читается как «reset 7091451031:: …» и ключ путается с токеном.
    logImpl(
      `reset for chat ${chatKey} -> ${result?.status ?? "unknown"} (token ${continuationToken})`,
    );
  } catch {
    // Журналирование не должно ронять сброс.
  }
}

export async function performScopedReset(
  chatKey,
  continuationToken,
  {
    clearQueue = false,
    persistIntentImpl = persistPrivateResetIntent,
    requestResetImpl = requestResetFromIntent,
    completeStateImpl = completeScopedResetState,
    clearIntentImpl = clearPrivateResetIntent,
    logImpl = log,
  } = {},
) {
  const intent = { chatKey, continuationToken };
  if (clearQueue) {
    try {
      await persistIntentImpl(chatKey, continuationToken);
    } catch (error) {
      error.resetPhase = "intent";
      throw error;
    }
  }
  try {
    await releaseScopedContinuation(chatKey, continuationToken, { requestResetImpl, logImpl });
  } catch (error) {
    throw error;
  }
  try {
    await completeStateImpl(chatKey, continuationToken, { clearQueue });
  } catch (error) {
    error.resetPhase = "cleanup";
    throw error;
  }
  if (clearQueue) {
    try {
      await clearIntentImpl(chatKey);
    } catch (error) {
      error.resetPhase = "intent-cleanup";
      throw error;
    }
  }
}

export async function reconcileScopedResetIntents({
  loadIntentsImpl = loadPrivateResetIntents,
  requestResetImpl = requestResetFromIntent,
  completeStateImpl = completeScopedResetState,
  clearIntentImpl = clearPrivateResetIntent,
  logImpl = log,
} = {}) {
  const intents = await loadIntentsImpl();
  for (const intent of intents) {
    // Интент мог быть записан версией до фикса #110 — с именем канала в токене.
    const continuationToken = toChannelLocalToken(intent.continuationToken);
    const result = await requestResetImpl({ ...intent, continuationToken });
    logResetOutcome(logImpl, intent.chatKey, continuationToken, result);
    await completeStateImpl(intent.chatKey, continuationToken, { clearQueue: true });
    await clearIntentImpl(intent.chatKey);
  }
  return intents.length;
}

function telegramTargetOf(chatKey) {
  const separator = chatKey.indexOf(":");
  if (separator <= 0) return null;
  const chatId = chatKey.slice(0, separator);
  if (!/^-?\d+$/.test(chatId)) return null;
  const thread = chatKey.slice(separator + 1);
  if (thread === "") return { chat_id: chatId };
  if (!/^\d+$/.test(thread)) return null;
  const messageThreadId = Number(thread);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0) return null;
  return { chat_id: chatId, message_thread_id: messageThreadId };
}

async function sendStaleRunNotice(chatKey, text) {
  const target = telegramTargetOf(chatKey);
  if (!target) throw new Error(`invalid Telegram chat key: ${chatKey}`);
  const data = await tg("sendMessage", { ...target, text });
  if (!data?.ok) throw new Error(data?.description || "sendMessage failed");
}

async function deleteStaleWorkingMessage(chatKey, messageId) {
  const target = telegramTargetOf(chatKey);
  if (!target) return;
  await tg("deleteMessage", {
    chat_id: target.chat_id,
    message_id: messageId,
  });
}

async function clearFailedDirectIngress(
  chatKey,
  {
    baselineGeneration,
    startedAt,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
  },
) {
  const current = statusImpl(chatKey);
  const observedAt = now();
  if (
    current?.status !== "running" ||
    current.sessionId !== undefined ||
    typeof current.ingressId !== "string" ||
    !Number.isFinite(current.ingressAt) ||
    current.ingressAt < startedAt ||
    current.ingressAt > observedAt ||
    statusGeneration(current) <= baselineGeneration
  ) {
    return false;
  }

  const cleared = setStatusIfImpl(
    chatKey,
    {
      status: "running",
      generation: current.generation,
      updatedAt: current.updatedAt,
      ingressId: current.ingressId,
      sessionId: undefined,
    },
    {
      status: "idle",
      sessionId: null,
      turnId: null,
      statusMessageId: null,
      ingressId: null,
      ingressAt: null,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      latencyLogged: null,
      wasCancelled: null,
      resetAt: observedAt,
    },
  );
  if (!cleared) return false;

  if (current.statusMessageId !== undefined && current.statusMessageId !== null) {
    try {
      await deleteMessageImpl(chatKey, current.statusMessageId);
    } catch {
      // Failed-attempt working messages are removed best-effort, like stale ones.
    }
  }
  return true;
}

export async function reapStaleRuns({
  listStatusesImpl = listChatStatuses,
  setStatusIfImpl = setChatStatusIf,
  resetImpl = releaseScopedContinuation,
  sendImpl = sendStaleRunNotice,
  deleteMessageImpl = deleteStaleWorkingMessage,
  now = Date.now,
  inFlight = queueInFlight,
  staleMs = RUN_STALE_MS,
  trImpl = tr,
  logImpl = log,
} = {}) {
  const safeLog = (...args) => {
    try {
      logImpl(...args);
    } catch {
      // Обслуживание протухших ходов не должно останавливать polling loop.
    }
  };

  let records;
  try {
    records = await listStatusesImpl();
  } catch (error) {
    safeLog("stale run scan failed:", error.message);
    return 0;
  }

  let reaped = 0;
  for (const record of records) {
    const key = record?.chatKey;
    const status = record?.status;
    if (
      typeof key !== "string" ||
      status?.status !== "running" ||
      now() - (status.updatedAt ?? 0) <= staleMs ||
      inFlight.has(key)
    ) {
      continue;
    }

    let flipped;
    const reapedAt = now();
    try {
      flipped = setStatusIfImpl(
        key,
        {
          status: "running",
          generation: status.generation,
          updatedAt: status.updatedAt,
        },
        {
          status: "idle",
          sessionId: null,
          turnId: null,
          statusMessageId: null,
          ingressId: null,
          ingressAt: null,
          statusAt: null,
          turnAt: null,
          firstOutputAt: null,
          latencyLogged: null,
          wasCancelled: null,
          resetAt: reapedAt,
        },
      );
    } catch (error) {
      safeLog(`stale run CAS failed for ${key}:`, error.message);
      continue;
    }
    if (!flipped) continue;
    reaped++;

    if (
      typeof status.continuationToken === "string" &&
      status.continuationToken.length > 0
    ) {
      try {
        // Статусы, записанные до фикса #110, хранят токен с именем канала впереди.
        await resetImpl(key, toChannelLocalToken(status.continuationToken));
      } catch (error) {
        safeLog(`stale run reset failed for ${key}:`, error.message);
      }
    } else {
      safeLog(`stale run ${key} has no continuation token`);
    }

    try {
      await sendImpl(
        key,
        trImpl(
          "The previous turn was interrupted - repeat your request or use /new",
          "Предыдущий ход оборвался - повтори запрос или /new",
        ),
      );
    } catch (error) {
      safeLog(`stale run notification failed for ${key}:`, error.message);
    }

    if (status.statusMessageId !== undefined && status.statusMessageId !== null) {
      try {
        await deleteMessageImpl(key, status.statusMessageId);
      } catch {
        // Старое статус-сообщение удаляется best-effort.
      }
    }
  }
  return reaped;
}

async function acknowledgeQueued(update, count) {
  const message = update.message;
  await tg("setMessageReaction", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reaction: [{ type: "emoji", emoji: "👀" }],
  }).catch((error) => log("reaction failed:", error.message));
  await tg("sendMessage", {
    chat_id: message.chat.id,
    text: tr(
      `Queued (${count}). I'll start it automatically when the current task finishes.`,
      `В очереди: ${count}. Начну автоматически, когда текущая задача завершится.`,
    ),
    ...(message.message_thread_id === undefined
      ? {}
      : { message_thread_id: message.message_thread_id }),
  }).catch((error) => log("queue status failed:", error.message));
}

export {
  QUEUE_FILE,
  queueSettleUntil,
  queueInFlight,
  queueDrainRotation,
  undrainableLegacyLogged,
  statusGeneration,
  sendStaleRunNotice,
  deleteStaleWorkingMessage,
  clearFailedDirectIngress,
  acknowledgeQueued,
  QUEUE_DELIVERY_TIMEOUT_MS,
  QUEUE_DRAIN_BUDGET_MS,
};
