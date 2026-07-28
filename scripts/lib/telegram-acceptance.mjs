import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export const TELEGRAM_ACCEPTANCE_ROUTE = "/eve/v1/telegram/accepted";
export const TELEGRAM_QUEUE_RECEIPT_FIELD = "iva_durable_queue_receipt";
export const TELEGRAM_ACCEPTANCE_KIND_HEADER = "x-iva-telegram-acceptance";

const receiptContext = new AsyncLocalStorage();
const RECEIPT_PATTERN = /^[a-f0-9]{32}$/u;

function validReceipt(value) {
  return typeof value === "string" && RECEIPT_PATTERN.test(value);
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

async function receiptFromRequest(request) {
  try {
    const body = await request.clone().json();
    const receipt = body?.message?.[TELEGRAM_QUEUE_RECEIPT_FIELD];
    return validReceipt(receipt) ? receipt : null;
  } catch {
    return null;
  }
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
export async function handleAcceptedTelegramWebhook(handler, request, args) {
  const receipt = await receiptFromRequest(request);
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
    return accepted || handled
      ? new Response(null, {
          status: 204,
          headers: { [TELEGRAM_ACCEPTANCE_KIND_HEADER]: accepted ? "turn" : "handled" },
        })
      : new Response("Telegram update was not accepted by Eve", { status: 503 });
  });
}
