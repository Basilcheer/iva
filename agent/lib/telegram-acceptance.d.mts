import type {
  TelegramContext,
  TelegramInboundResultOrPromise,
  TelegramMessage,
} from "eve/channels/telegram";
import type { RouteHandlerArgs } from "eve/channels";

export declare const TELEGRAM_ACCEPTANCE_ROUTE: "/eve/v1/telegram/accepted";
export declare const TELEGRAM_QUEUE_RECEIPT_FIELD: "iva_durable_queue_receipt";
export declare const TELEGRAM_ACCEPTANCE_KIND_HEADER: "x-iva-telegram-acceptance";

export declare function addTelegramQueueReceipt(
  update: Record<string, unknown>,
  receipt?: string,
): Record<string, unknown>;

export declare function wrapTelegramQueueOnMessage(
  onMessage: (
    context: TelegramContext,
    message: TelegramMessage,
  ) => TelegramInboundResultOrPromise,
): (
  context: TelegramContext,
  message: TelegramMessage,
) => Promise<Awaited<TelegramInboundResultOrPromise>>;

export declare function handleAcceptedTelegramWebhook<TState>(
  handler: (
    request: Request,
    args: RouteHandlerArgs<TState>,
  ) => Promise<Response>,
  request: Request,
  args: RouteHandlerArgs<TState>,
  options?: { completedUpdatesFile?: string },
): Promise<Response>;
