import {
  COLLECT_QUIET_MS,
  collectorOffer,
  collectorPending,
  collectorRestore,
  collectorTakeExpired,
  createCollector,
} from "../lib/telegram-collect.mjs";
import { alreadyDelivered } from "../lib/offset-store.mjs";
import { isReplyToBot, migrateQueueFile } from "../lib/telegram-queue.mjs";
import {
  ACCEPTANCE_ROUTE,
  ROUTE,
  SECRET,
  TOKEN,
  log,
  sleep,
} from "./config.mjs";
import { tg } from "./transport.mjs";
import { fastForwardOffset, loadOffset, saveOffset } from "./offset.mjs";
import {
  QUEUE_FILE,
  reapStaleRuns,
  reconcileScopedResetIntents,
} from "./queue.mjs";
import { drainReadyQueueHeads, routeMessageUpdate } from "./routing.mjs";
import { removeStaleUpdateJobs } from "./update-flow.mjs";
import { handleControl, registerBotCommands } from "./control.mjs";

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
  let { offset, delivered } = await loadOffset();
  // First run (no offset file) — drop the accumulated install backlog (drop_pending=true),
  // so old messages don't replay in a batch → parallel sessions on one chat (HookConflict).
  // On subsequent starts we do NOT drop the backlog (don't lose messages that arrived while the bridge was down).
  const firstRun = offset === null;
  const dw = await tg("deleteWebhook", { drop_pending_updates: firstRun });
  log(
    "deleteWebhook:",
    dw.ok ? `ok (drop_pending=${firstRun})` : dw.description,
  );
  await registerBotCommands();

  if (offset === null) {
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
    } catch (e) {
      log("stale run reaper failed:", e.message);
    }
    let pendingQueueCount = await drainReadyQueueHeads();
    let collectorWriteFailed = false;
    for (const update of collectorTakeExpired(messageCollector, Date.now())) {
      const routed = await routeMessageUpdate(update);
      if (routed === "delivered") {
        delivered =
          delivered === null
            ? update.update_id
            : Math.max(delivered, update.update_id);
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
    let data;
    try {
      data = await tg(
        "getUpdates",
        {
          offset,
          timeout: pollSeconds,
          allowed_updates: ["message", "callback_query"],
        },
        { timeoutMs: pollSeconds > 1 ? 40_000 : 10_000 },
      );
    } catch (e) {
      log("getUpdates network:", e.message);
      await sleep(3000);
      continue;
    }
    if (!data.ok) {
      log("getUpdates:", data.description);
      // 409/conflict — a webhook is left somewhere; remove it and try again.
      if (/409|conflict|webhook/i.test(data.description || "")) {
        await tg("deleteWebhook", { drop_pending_updates: false });
      }
      await sleep(3000);
      continue;
    }
    let queueWriteFailed = false;
    for (const update of data.result || []) {
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
      let candidate = update;
      let collected = false;
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
          collected = true;
          offset = update.update_id + 1;
          await saveOffset(offset, delivered);
        }
      }

      const routed = await routeMessageUpdate(candidate);
      if (routed === "enqueue-failed") {
        if (collected) collectorRestore(messageCollector, candidate);
        // Passthrough retains the old durable retry point. Collected parts already
        // advanced offset when buffered and retry from the restored in-memory burst.
        queueWriteFailed = true;
        break;
      }
      if (!collected) offset = update.update_id + 1;
      if (routed === "delivered") {
        delivered =
          delivered === null
            ? candidate.update_id
            : Math.max(delivered, candidate.update_id);
      }
      await saveOffset(offset, delivered);
    }
    if (queueWriteFailed) await sleep(3000);
  }
}
