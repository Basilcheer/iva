import {
  acknowledgeQueueHead,
  enqueueQueueFile,
  isReplyToBot,
  materializeQueueItem,
  queueCount,
  queueHead,
  queueKeys,
  shouldQueueBusyUpdate,
  TELEGRAM_QUEUE_FATAL_DURABILITY,
} from "../lib/telegram-queue.ts";
import {
  getChatStatus,
  isRunning,
  RUN_STALE_MS,
  setChatStatusIf,
} from "#lib/run-status.mjs";
import { tr } from "#lib/i18n.mjs";
import {
  ACCEPTANCE_ROUTE,
  ALLOWED,
  BOT_USERNAME,
  DIRECT_ACCEPTANCE_TIMEOUT_MS,
  SETTLE_MS,
  log,
} from "./config.mjs";
import { chatKey } from "./offset.mjs";
import { pacedDeliver } from "./deliver.mjs";
import {
  acknowledgeQueued,
  clearFailedDirectIngress,
  deleteStaleWorkingMessage,
  loadQueue,
  QUEUE_DELIVERY_TIMEOUT_MS,
  QUEUE_DRAIN_BUDGET_MS,
  QUEUE_FILE,
  queueDrainRotation,
  queueInFlight,
  queueSettleUntil,
  sendStaleRunNotice,
  statusGeneration,
  undrainableLegacyLogged,
} from "./queue.mjs";

async function deliverDirectUpdate(
  update,
  {
    key = chatKey(update),
    deliverImpl = pacedDeliver,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    sendFailureImpl = sendStaleRunNotice,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
    trImpl = tr,
    logImpl = log,
  } = {},
) {
  // The acceptance wrapper does not cover callback_query dispatch. Keeping this
  // call option-free also preserves the old webhook path for real callbacks and
  // the synthetic /stop callback.
  if (!update.message || key === null) {
    const accepted = await deliverImpl(update);
    return accepted ? "delivered" : "rejected";
  }

  const startedAt = now();
  const baselineGeneration = statusGeneration(statusImpl(key));
  let acceptanceFailureReported = false;
  let failureNotified = false;
  const onAcceptanceFailure = async () => {
    acceptanceFailureReported = true;
    try {
      await clearFailedDirectIngress(key, {
        baselineGeneration,
        startedAt,
        statusImpl,
        setStatusIfImpl,
        deleteMessageImpl,
        now,
      });
    } catch (error) {
      logImpl(
        `direct delivery status cleanup failed for ${key}:`,
        error.message,
      );
    }

    if (failureNotified) return;
    failureNotified = true;
    try {
      await sendFailureImpl(
        key,
        trImpl(
          "Couldn't process the message - repeat it or use /new",
          "Не получилось обработать сообщение - повтори или /new",
        ),
      );
    } catch (error) {
      logImpl(`direct delivery notification failed for ${key}:`, error.message);
    }
  };

  const accepted = await deliverImpl(update, {
    onAcceptanceFailure,
    timeoutMs: DIRECT_ACCEPTANCE_TIMEOUT_MS,
    retryAcceptanceTimeout: false,
  });
  // Defensive fallback for injected/custom deliverers and for a pacing deadline
  // that expires before fetch starts.
  if (!accepted && !acceptanceFailureReported) await onAcceptanceFailure();
  return accepted ? "delivered" : "rejected";
}

export async function routeMessageUpdate(
  update,
  {
    chatKeyImpl = chatKey,
    loadQueueImpl = loadQueue,
    runningImpl = isRunning,
    inFlight = queueInFlight,
    queueCountImpl = queueCount,
    replyToBotImpl = isReplyToBot,
    shouldQueueImpl = shouldQueueBusyUpdate,
    enqueueImpl = (key, candidate) =>
      enqueueQueueFile(QUEUE_FILE, key, candidate),
    acknowledgeImpl = acknowledgeQueued,
    deliverImpl = pacedDeliver,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    sendFailureImpl = sendStaleRunNotice,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
    trImpl = tr,
    allowedUserIds = ALLOWED,
    botUsername = BOT_USERNAME,
    logImpl = log,
  } = {},
) {
  const key = chatKeyImpl(update);
  if (update.message && key !== null && !replyToBotImpl(update.message)) {
    const queue = await loadQueueImpl();
    const mustQueue =
      runningImpl(key) || inFlight.has(key) || queueCountImpl(queue, key) > 0;
    if (mustQueue) {
      if (!shouldQueueImpl(update, { allowedUserIds, botUsername }))
        return "dropped";
      let queued;
      try {
        queued = await enqueueImpl(key, update);
      } catch (error) {
        logImpl(
          `queue enqueue failed for update ${update.update_id}:`,
          error.message,
        );
        return "enqueue-failed";
      }
      await acknowledgeImpl(update, queued.count);
      return "queued";
    }
  }

  return deliverDirectUpdate(update, {
    key,
    deliverImpl,
    statusImpl,
    setStatusIfImpl,
    sendFailureImpl,
    deleteMessageImpl,
    now,
    trImpl,
    logImpl,
  });
}

export async function drainReadyQueueHeads({
  loadImpl = loadQueue,
  runningImpl = isRunning,
  statusImpl = getChatStatus,
  deliverImpl = (update, { timeoutMs }) =>
    pacedDeliver(update, {
      route: ACCEPTANCE_ROUTE,
      acceptedStatus: 204,
      queueReceipt: true,
      retry: false,
      timeoutMs,
    }),
  acknowledgeImpl = (key, updateId) =>
    acknowledgeQueueHead(QUEUE_FILE, key, updateId),
  legacyAllowedUserIds = ALLOWED,
  now = Date.now,
  settleUntil = queueSettleUntil,
  inFlight = queueInFlight,
  rotationState = queueDrainRotation,
  passBudgetMs = QUEUE_DRAIN_BUDGET_MS,
  deliveryTimeoutMs = QUEUE_DELIVERY_TIMEOUT_MS,
  gateWaitMs = RUN_STALE_MS,
} = {}) {
  const snapshot = await loadImpl();
  const keys = [...new Set([...queueKeys(snapshot), ...inFlight.keys()])];
  const previousIndex = keys.indexOf(rotationState.afterKey);
  const orderedKeys =
    previousIndex < 0
      ? keys
      : [...keys.slice(previousIndex + 1), ...keys.slice(0, previousIndex + 1)];
  const deadline = now() + passBudgetMs;
  let exhausted = false;
  let lastAttempted = null;

  for (const key of orderedKeys) {
    if (now() >= deadline) {
      exhausted = true;
      break;
    }
    const currentStatus = statusImpl(key);
    const currentGeneration = statusGeneration(currentStatus);
    const running = runningImpl(key);
    const phase = inFlight.get(key);
    if (phase?.state === "delivering") continue;
    if (phase?.state === "awaiting-running") {
      if (running) {
        inFlight.set(key, {
          ...phase,
          state: "running",
          generation: currentGeneration,
        });
        continue;
      }
      const generationAdvanced = currentGeneration > phase.baselineGeneration;
      const waitExpired = now() - phase.acceptedAt >= gateWaitMs;
      if (!generationAdvanced && !waitExpired) continue;
      inFlight.delete(key);
    }
    if (phase?.state === "running") {
      if (running) continue;
      inFlight.delete(key);
    }
    const item = queueHead(snapshot, key);
    if (!item) continue;
    if (running || (settleUntil.get(key) ?? 0) > now()) continue;
    const update = materializeQueueItem(key, item, { legacyAllowedUserIds });
    if (!update) {
      if (!undrainableLegacyLogged.has(key)) {
        log(
          `queued legacy messages for ${key} cannot be replayed because their author is not verifiable`,
        );
        undrainableLegacyLogged.add(key);
      }
      continue;
    }
    const timeoutMs = Math.max(
      1,
      Math.min(deliveryTimeoutMs, deadline - now()),
    );
    lastAttempted = key;
    const baselineGeneration = currentGeneration;
    inFlight.set(key, { state: "delivering", baselineGeneration });
    let accepted = false;
    try {
      accepted = await deliverImpl(update, { timeoutMs });
    } catch (error) {
      log(`queued update ${item.updateId} delivery failed:`, error.message);
    }
    if (!accepted) {
      inFlight.delete(key);
      continue;
    }
    if (accepted === "handled") {
      inFlight.delete(key);
    } else {
      const acceptedStatus = statusImpl(key);
      const acceptedGeneration = statusGeneration(acceptedStatus);
      if (runningImpl(key)) {
        inFlight.set(key, {
          state: "running",
          baselineGeneration,
          generation: acceptedGeneration,
        });
      } else if (acceptedGeneration > baselineGeneration) {
        // A complete running -> idle cycle happened while acceptance was pending.
        inFlight.delete(key);
      } else {
        inFlight.set(key, {
          state: "awaiting-running",
          baselineGeneration,
          acceptedAt: now(),
        });
      }
    }
    // Keep a just-accepted head until its removal is itself durable. If this write
    // fails, the next pass deliberately replays the same head (at-least-once).
    try {
      await acknowledgeImpl(key, item.updateId);
      settleUntil.set(key, now() + Math.max(SETTLE_MS, 0));
    } catch (error) {
      if (error?.code === TELEGRAM_QUEUE_FATAL_DURABILITY) {
        inFlight.delete(key);
        rotationState.afterKey = null;
        throw error;
      }
      log(
        `queued update ${item.updateId} ack failed; head retained or restored:`,
        error.message,
      );
    }
  }
  rotationState.afterKey = exhausted ? lastAttempted : null;
  return queueCount(await loadImpl());
}

export { deliverDirectUpdate };
