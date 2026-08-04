import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { acquireLock, loadJsonStrict, releaseLock, saveJsonAtomic } from "./json-store.ts";

export const TELEGRAM_ACCEPTANCE_ROUTE = "/eve/v1/telegram/accepted";
export const TELEGRAM_QUEUE_RECEIPT_FIELD = "iva_durable_queue_receipt";
export const TELEGRAM_ACCEPTANCE_KIND_HEADER = "x-iva-telegram-acceptance";

const receiptContext = new AsyncLocalStorage();
const RECEIPT_PATTERN = /^[a-f0-9]{32}$/u;
const COMPLETED_UPDATES_LIMIT = 200;

function validReceipt(value) {
  return typeof value === "string" && RECEIPT_PATTERN.test(value);
}

function hasValidWebhookSecret(request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  const supplied = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function addTelegramQueueReceipt(
  update,
  receipt = randomBytes(16).toString("hex"),
) {
  if (
    typeof update !== "object" ||
    update === null ||
    Array.isArray(update) ||
    typeof update.message !== "object" ||
    update.message === null ||
    Array.isArray(update.message) ||
    !validReceipt(receipt)
  ) {
    throw new Error("Telegram queue receipt requires a message update and a 128-bit hex id");
  }
  return {
    ...update,
    message: {
      ...update.message,
      [TELEGRAM_QUEUE_RECEIPT_FIELD]: receipt,
    },
  };
}

export function wrapTelegramQueueOnMessage(onMessage) {
  return async (context, message) => {
    const raw = message?.raw;
    const receipt =
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      validReceipt(raw[TELEGRAM_QUEUE_RECEIPT_FIELD])
        ? raw[TELEGRAM_QUEUE_RECEIPT_FIELD]
        : null;
    if (typeof raw === "object" && raw !== null) {
      Reflect.deleteProperty(raw, TELEGRAM_QUEUE_RECEIPT_FIELD);
    }

    const result = await onMessage(context, message);
    const active = receiptContext.getStore();
    if (result === null && receipt !== null && active?.receipt === receipt) {
      active.handled = true;
    }
    return result;
  };
}

async function metadataFromRequest(request) {
  try {
    const body = await request.clone().json();
    const receipt = body?.message?.[TELEGRAM_QUEUE_RECEIPT_FIELD];
    return {
      receipt: validReceipt(receipt) ? receipt : null,
      updateId:
        Number.isSafeInteger(body?.update_id) && body.update_id >= 0
          ? body.update_id
          : null,
    };
  } catch {
    return { receipt: null, updateId: null };
  }
}

function validCompletedUpdates(value) {
  if (!Array.isArray(value) || !value.every((id) => Number.isSafeInteger(id))) {
    throw new Error("completed Telegram update ledger has invalid schema");
  }
  return value;
}

async function withCompletedLedger(file, fn) {
  const lock = `${file}.lock`;
  const token = await acquireLock(lock);
  try {
    return await fn();
  } finally {
    releaseLock(lock, token);
  }
}

async function hasCompletedUpdate(file, updateId) {
  return withCompletedLedger(file, async () =>
    validCompletedUpdates(await loadJsonStrict(file, [])).includes(updateId));
}

async function recordCompletedUpdate(file, updateId) {
  return withCompletedLedger(file, async () => {
    const current = validCompletedUpdates(await loadJsonStrict(file, []));
    const next = current.includes(updateId)
      ? current
      : [...current, updateId].slice(-COMPLETED_UPDATES_LIMIT);
    if (next !== current) await saveJsonAtomic(file, next);
  });
}

// telegramChannel acknowledges webhooks before its waitUntil dispatch has called
// send(). The polling bridge needs a stronger receipt for durable FIFO replay:
// this wrapper runs the authored channel handler unchanged, but waits until its
// real Eve send has resolved before returning success.
/**
 * @param {(request: Request, args: any) => Promise<Response>} handler
 * @param {Request} request
 * @param {any} args
 * @returns {Promise<Response>}
 */
export async function handleAcceptedTelegramWebhook(handler, request, args, options = {}) {
  const { receipt, updateId } = await metadataFromRequest(request);
  const completedFile =
    options.completedUpdatesFile ??
    join(process.env.ASSISTANT_DATA_DIR ?? "data", "completed-updates.json");
  // Старые/нестандартные payload без update_id сохраняют прежний путь обработки.
  if (
    updateId !== null &&
    hasValidWebhookSecret(request) &&
    await hasCompletedUpdate(completedFile, updateId)
  ) {
    return new Response(null, {
      status: 204,
      headers: { [TELEGRAM_ACCEPTANCE_KIND_HEADER]: "handled" },
    });
  }
  return receiptContext.run({ receipt, handled: false }, async () => {
    /** @type {Promise<unknown>[]} */
    const background = [];
    let accepted = false;

    const response = await handler(request, {
      ...args,
      send: async (...sendArgs) => {
        const session = await args.send(...sendArgs);
        accepted = true;
        return session;
      },
      waitUntil: (task) => {
        background.push(Promise.resolve(task));
      },
    });

    if (!response.ok) return response;
    await Promise.allSettled(background);
    const handled = receiptContext.getStore()?.handled === true;
    if (accepted || handled) {
      if (updateId !== null) {
        try {
          await recordCompletedUpdate(completedFile, updateId);
        } catch (error) {
          // Ход уже принят: ошибка ledger не должна вернуть 5xx и запустить тот же ход снова.
          console.error("[telegram] не смог записать завершённый update:", error);
        }
      }
      return new Response(null, {
        status: 204,
        headers: { [TELEGRAM_ACCEPTANCE_KIND_HEADER]: accepted ? "turn" : "handled" },
      });
    }
    return new Response("Telegram update was not accepted by Eve", { status: 503 });
  });
}
