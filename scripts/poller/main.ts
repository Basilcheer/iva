import { fileURLToPath } from "node:url";

import {
  COLLECT_QUIET_MS,
  collectorOffer,
  collectorPending,
  collectorRestore,
  collectorTakeExpired,
  createCollector,
  type TelegramCollectUpdate,
} from "../lib/telegram-collect.ts";
import { alreadyDelivered } from "../lib/offset-store.ts";
import {
  isReplyToBot,
  invalidTelegramUpdatesDiagnostic,
  migrateQueueFile,
  parseTelegramUpdates,
  type TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  ACCEPTANCE_ROUTE,
  ROUTE,
  SECRET,
  TOKEN,
  log,
  sleep,
} from "./config.ts";
import { tg } from "./transport.ts";
import { fastForwardOffset, loadOffset, saveOffset } from "./offset.ts";
import * as queue from "./queue.ts";
import * as routing from "./routing.ts";
import * as updateFlow from "./update-flow.ts";
import * as control from "./control.ts";
import * as wizards from "./wizards.ts";

type ErrorLike = { message?: unknown };
type TelegramResponse = {
  ok?: unknown;
  description?: string;
  result?: unknown;
};
const { QUEUE_FILE, reapStaleRuns, reconcileScopedResetIntents } = queue;
const { drainReadyQueueHeads, routeMessageUpdate } = routing;
const { reconcileUpdateJobs, removeStaleUpdateJobs } = updateFlow;
const { handleControl, registerBotCommands } = control;

export { readCappedStream } from "./transport.ts";
export const loadQueue = queue.loadQueue;
export const writeQueueAtomic = queue.writeQueueAtomic;
export const completeScopedResetState = queue.completeScopedResetState;
export const persistPrivateResetIntent = queue.persistPrivateResetIntent;
export const loadPrivateResetIntents = queue.loadPrivateResetIntents;
export const clearPrivateResetIntent = queue.clearPrivateResetIntent;
export const releaseScopedContinuation = queue.releaseScopedContinuation;
export const performScopedReset = queue.performScopedReset;
export { reconcileScopedResetIntents, reapStaleRuns };
export { routeMessageUpdate, drainReadyQueueHeads };
export const handleUpdateCheck = updateFlow.handleUpdateCheck;
export const handleUpdateCallback = updateFlow.handleUpdateCallback;
export const runWizardRequest = wizards.runWizardRequest;
export const isStaleWizard = wizards.isStaleWizard;
export const wizardActionAllowed = wizards.wizardActionAllowed;
export const selectWizardModel = wizards.selectWizardModel;
export const selectWizardEffort = wizards.selectWizardEffort;
export const selectableWizardOptions = wizards.selectableWizardOptions;
export const resolveThinkCatalogLoad = wizards.resolveThinkCatalogLoad;
export const validateAndSaveWizard = wizards.validateAndSaveWizard;
export const resetMessageCopy = wizards.resetMessageCopy;
export const handleAwaitNonText = control.handleAwaitNonText;

const errorMessage = (error: unknown) => (error as ErrorLike).message;

const rawCollectQuietMs = Number(
  process.env.TELEGRAM_COLLECT_QUIET_MS ?? COLLECT_QUIET_MS,
);
const configuredCollectQuietMs =
  Number.isFinite(rawCollectQuietMs) && rawCollectQuietMs >= 0
    ? rawCollectQuietMs
    : COLLECT_QUIET_MS;
const messageCollector = createCollector({ quietMs: configuredCollectQuietMs });

export async function main() {
  if (!TOKEN)
    throw new Error("no TELEGRAM_BOT_TOKEN in .env — nothing to poll");
  if (!SECRET)
    throw new Error(
      "no TELEGRAM_WEBHOOK_SECRET_TOKEN — the channel won't accept updates",
    );
  log(`telegram-poll start → messages ${ACCEPTANCE_ROUTE}; callbacks ${ROUTE}`);
  await removeStaleUpdateJobs();
  // The update that restarted this bridge left its final screen to us: its own
  // process died with the restart. Delivered before the first poll; the jobs with
  // nothing to say yet are watched beside it.
  const watched = await reconcileUpdateJobs();
  if (watched.length > 0)
    log(`watching ${watched.length} unfinished update job(s)`);
  // Upgrade the old {chatKey: string[]} queue atomically before polling. A failed
  // migration stops the bridge, so Telegram retains new updates until the old bytes
  // are safely represented as versioned FIFO items.
  await migrateQueueFile(QUEUE_FILE, {
    onLegacyQuarantine: (path) =>
      log(
        `legacy Telegram group messages moved to ${path}; sender identity was unavailable`,
      ),
  });
  const reconciledResets = await reconcileScopedResetIntents();
  if (reconciledResets > 0) {
    log(
      `reconciled ${reconciledResets} durable private Telegram reset intent(s)`,
    );
  }
  // Читаем offset ДО любого destructive Telegram-вызова: EACCES/EIO/битый JSON
  // останавливают мост, пока backlog ещё цел. Только подтверждённый ENOENT означает
  // first run и разрешает drop_pending=true.
  const storedOffset = await loadOffset();
  let offset = storedOffset.offset ?? 0;
  let { delivered } = storedOffset;
  // First run (no offset file) — drop the accumulated install backlog (drop_pending=true),
  // so old messages don't replay in a batch → parallel sessions on one chat (HookConflict).
  // On subsequent starts we do NOT drop the backlog (don't lose messages that arrived while the bridge was down).
  const firstRun = storedOffset.offset === null;
  const dw = (await tg("deleteWebhook", {
    drop_pending_updates: firstRun,
  })) as TelegramResponse;
  log(
    "deleteWebhook:",
    dw.ok ? `ok (drop_pending=${firstRun})` : dw.description,
  );
  await registerBotCommands();

  if (firstRun) {
    offset = await fastForwardOffset();
    log("first run — offset past the tail of the queue:", offset);
    await saveOffset(offset);
  } else {
    log("starting offset:", offset);
  }

  for (;;) {
    // One head per idle chat/topic per pass. While any queue remains, use a short
    // Telegram long-poll so terminal/stale run-status changes trigger drain quickly.
    try {
      await reapStaleRuns();
    } catch (error) {
      log("stale run reaper failed:", errorMessage(error));
    }
    let pendingQueueCount = await drainReadyQueueHeads();
    let collectorWriteFailed = false;
    for (const update of collectorTakeExpired(messageCollector, Date.now())) {
      const routed = await routeMessageUpdate(update);
      if (routed === "delivered") {
        const updateId = update.update_id;
        delivered =
          delivered === null ? updateId : Math.max(delivered, updateId);
        await saveOffset(offset, delivered);
      } else if (routed === "queued") {
        pendingQueueCount = Math.max(1, pendingQueueCount);
      } else if (routed === "enqueue-failed") {
        collectorRestore(messageCollector, update);
        collectorWriteFailed = true;
      }
    }
    if (collectorWriteFailed) {
      await sleep(3000);
      continue;
    }
    const pollSeconds =
      pendingQueueCount > 0 || collectorPending(messageCollector) > 0 ? 1 : 30;
    let data: TelegramResponse;
    try {
      data = (await tg(
        "getUpdates",
        {
          offset,
          timeout: pollSeconds,
          allowed_updates: ["message", "callback_query"],
        },
        { timeoutMs: pollSeconds > 1 ? 40_000 : 10_000 },
      )) as TelegramResponse;
    } catch (error) {
      log("getUpdates network:", errorMessage(error));
      await sleep(3000);
      continue;
    }
    if (!data.ok) {
      log("getUpdates:", data.description);
      // 409/conflict — a webhook is left somewhere; remove it and try again.
      if (/409|conflict|webhook/i.test(String(data.description || ""))) {
        await tg("deleteWebhook", { drop_pending_updates: false });
      }
      await sleep(3000);
      continue;
    }
    const updates = parseTelegramUpdates(data.result);
    if (updates === null) {
      log(
        "getUpdates: invalid result",
        JSON.stringify(invalidTelegramUpdatesDiagnostic(data.result)),
      );
      await sleep(3000);
      continue;
    }
    let queueWriteFailed = false;
    for (const update of updates) {
      // Переигровка после краша (Telegram = at-least-once): этот апдейт уже уходил в eve
      // в прошлой жизни процесса — второй раз не доставляем, только двигаем offset.
      if (alreadyDelivered(update.update_id, delivered)) {
        log(
          `skip update ${update.update_id} — already delivered before restart`,
        );
        offset = update.update_id + 1;
        await saveOffset(offset, delivered);
        continue;
      }
      // Control commands (/restart, /help, /new) — the bridge handles them itself, doesn't send to eve.
      if (await handleControl(update)) {
        offset = update.update_id + 1;
        await saveOffset(offset, delivered);
        continue;
      }
      let candidate: TelegramQueueUpdate = update;
      let collectedUpdate: TelegramCollectUpdate | null = null;
      if (update.message && !isReplyToBot(update.message)) {
        const offered = collectorOffer(messageCollector, update, Date.now());
        if (offered.status === "buffered") {
          // The quiet-window buffer is intentionally in-memory. Advancing now avoids
          // replaying every part, but a process crash can lose this one pending burst.
          offset = update.update_id + 1;
          await saveOffset(offset, delivered);
          continue;
        }
        if (offered.status === "ready") {
          candidate = offered.update;
          collectedUpdate = offered.update;
          offset = update.update_id + 1;
          await saveOffset(offset, delivered);
        }
      }

      const routed = await routeMessageUpdate(candidate);
      if (routed === "enqueue-failed") {
        if (collectedUpdate)
          collectorRestore(messageCollector, collectedUpdate);
        // Passthrough retains the old durable retry point. Collected parts already
        // advanced offset when buffered and retry from the restored in-memory burst.
        queueWriteFailed = true;
        break;
      }
      if (!collectedUpdate) offset = update.update_id + 1;
      if (routed === "delivered") {
        const candidateId = candidate.update_id;
        delivered =
          delivered === null ? candidateId : Math.max(delivered, candidateId);
      }
      await saveOffset(offset, delivered);
    }
    if (queueWriteFailed) await sleep(3000);
  }
}

export function runEntrypoint(
  moduleUrl: string,
  executedPath: string | undefined = process.argv[1],
): void {
  if (fileURLToPath(moduleUrl) !== executedPath) return;
  void main().catch((error: unknown) => {
    console.error("telegram-poll fatal:", error);
    process.exit(1);
  });
}
