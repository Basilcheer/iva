import type {
  TelegramContext,
  TelegramInboundResultOrPromise,
  TelegramMessage,
} from "eve/channels/telegram";

export declare const TELEGRAM_ACCEPTANCE_ROUTE: "/eve/v1/telegram/accepted";
export declare const TELEGRAM_QUEUE_RECEIPT_FIELD: "iva_durable_queue_receipt";
export declare const TELEGRAM_ACCEPTANCE_KIND_HEADER: "x-iva-telegram-acceptance";

export declare function addTelegramQueueReceipt(
  update: Record<string, any>,
  receipt?: string,
): Record<string, any>;

export declare function wrapTelegramQueueOnMessage(
  onMessage: (
    context: TelegramContext,
    message: TelegramMessage,
  ) => TelegramInboundResultOrPromise,
): (
  context: TelegramContext,
  message: TelegramMessage,
) => Promise<Awaited<TelegramInboundResultOrPromise>>;

type AcceptanceArgs = {
  send: (...args: any[]) => Promise<any>;
  waitUntil: (task: Promise<unknown>) => void;
};

export declare function handleAcceptedTelegramWebhook<TArgs extends AcceptanceArgs>(
  handler: (request: Request, args: TArgs) => Promise<Response>,
  request: Request,
  args: TArgs,
): Promise<Response>;
