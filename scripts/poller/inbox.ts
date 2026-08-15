import { join } from "node:path";
import {
  acknowledgeQueueHead,
  enqueueQueueFile,
  isTelegramQueueUpdate,
  loadQueueFile,
  queueCount,
  queueKeys,
  shouldQueueBusyUpdate,
  type TelegramQueueItem,
  type TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  collectorKeyFor,
  collectorOffer,
  collectorTakeExpired,
  createCollector,
} from "../lib/telegram-collect.ts";
import { ALLOWED, BOT_USERNAME, DATA_DIR, log } from "./config.ts";
import { routeMessageUpdate, type RouteMessageResult } from "./routing.ts";

export const TELEGRAM_INBOX_FILE = join(DATA_DIR, "telegram-inbox.json");

export type InboxCollectorOptions = {
  quietMs?: unknown;
  mediaQuietMs?: unknown;
  maxParts?: unknown;
  maxChars?: unknown;
  maxAgeMs?: unknown;
};

export type ReadyInboxBatch = {
  update: TelegramQueueUpdate;
  updateIds: number[];
};

export function selectReadyInboxBatch(
  key: string,
  items: readonly TelegramQueueItem[],
  now: number,
  collectorOptions: InboxCollectorOptions = {},
): ReadyInboxBatch | null {
  const collector = createCollector(collectorOptions);
  const updateIds: number[] = [];
  for (const item of items) {
    const update = item.update;
    if (
      !isTelegramQueueUpdate(update) ||
      collectorKeyFor(update) !== key ||
      typeof item.enqueuedAt !== "number" ||
      !Number.isFinite(item.enqueuedAt) ||
      item.enqueuedAt < 0
    ) {
      throw new Error(`invalid durable Telegram inbox item ${item.updateId}`);
    }
    updateIds.push(item.updateId);
    const offered = collectorOffer(collector, update, item.enqueuedAt);
    if (offered.status === "passthrough" || offered.status === "ready") {
      return { update: offered.update, updateIds: [...updateIds] };
    }
  }
  const [expired] = collectorTakeExpired(collector, now);
  return expired ? { update: expired, updateIds } : null;
}

export async function admitMessageUpdate(
  update: TelegramQueueUpdate,
  {
    allowedUserIds = ALLOWED,
    botUsername = BOT_USERNAME,
    enqueueImpl = (key: string, candidate: TelegramQueueUpdate) =>
      enqueueQueueFile(TELEGRAM_INBOX_FILE, key, candidate, { strict: true }),
    logImpl = log,
  }: {
    allowedUserIds?: ReadonlySet<string>;
    botUsername?: unknown;
    enqueueImpl?: (
      key: string,
      candidate: TelegramQueueUpdate,
    ) => Promise<unknown>;
    logImpl?: (...parts: unknown[]) => void;
  } = {},
): Promise<"owned" | "dropped" | "write-failed"> {
  const key = collectorKeyFor(update);
  if (
    key === null ||
    !shouldQueueBusyUpdate(update, { allowedUserIds, botUsername })
  ) {
    return "dropped";
  }
  try {
    await enqueueImpl(key, update);
    return "owned";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logImpl(`inbox write failed for update ${update.update_id}:`, message);
    return "write-failed";
  }
}

export async function promoteReadyInbox({
  now = Date.now,
  collectorOptions = {},
  loadImpl = async () =>
    (await loadQueueFile(TELEGRAM_INBOX_FILE, { strict: true })).document,
  routeImpl = routeMessageUpdate,
  acknowledgeImpl = (key: string, updateId: number) =>
    acknowledgeQueueHead(TELEGRAM_INBOX_FILE, key, updateId, { strict: true }),
}: {
  now?: () => number;
  collectorOptions?: InboxCollectorOptions;
  loadImpl?: () => Promise<
    Awaited<ReturnType<typeof loadQueueFile>>["document"]
  >;
  routeImpl?: (update: TelegramQueueUpdate) => Promise<RouteMessageResult>;
  acknowledgeImpl?: (key: string, updateId: number) => Promise<unknown>;
} = {}): Promise<number> {
  const snapshot = await loadImpl();
  for (const key of queueKeys(snapshot)) {
    const batch = selectReadyInboxBatch(
      key,
      snapshot.queues[key],
      now(),
      collectorOptions,
    );
    if (!batch) continue;
    const routed = await routeImpl(batch.update);
    if (routed !== "queued" && routed !== "delivered") continue;
    for (const updateId of batch.updateIds) {
      await acknowledgeImpl(key, updateId);
    }
  }
  return queueCount(await loadImpl());
}
