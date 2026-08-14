// Статус-сообщение хода: «Работаю…» с кнопкой [⏹ Стоп] и его уборка в терминале.
// Это UI самого канала, не текст модели, поэтому мимо Outbox.
//
// turn.started шлёт статус и пишет running+continuationToken+turnId в run-status.
// Нажатие кнопки (и /stop) ловит мост: он берёт из статуса токен и зовёт cancel-роут
// канала, а terminal-событие приводит статус в порядок: обычный финал удаляет
// сообщение, отмена переписывает его на «Остановлено».
//
// Про eve модуль не знает: канал передаёт хендл Bot API структурно.
import { tr } from "./i18n.ts";
import { chatKeyOf, getChatStatus, setChatStatusIf } from "./run-status.ts";
import { toChannelLocalToken } from "./telegram-continuation-token.ts";

// В callback_data кладём только константу: лимит 64 байта не вмещает sessionId,
// он и так лежит в run-status.
export const TELEGRAM_STOP_CALLBACK = "iva_cancel";

export type TelegramStatusHandle = {
  readonly chatId: string;
  readonly messageThreadId?: number;
  request(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; body: unknown }>;
};

// Функция, а не const: перевод выбирается в момент вызова (правило репо — module-level
// const не должна захватывать tr(), иначе язык замерзает до рестарта).
function stoppedText(): string {
  return tr(
    "⏹ Stopped. I'll hold new messages and handle them together with the next one.",
    "⏹ Остановлено. Новые сообщения накоплю и обработаю вместе со следующим.",
  );
}

export const stopReplyMarkup = () => ({
  inline_keyboard: [
    [{ text: tr("⏹ Stop", "⏹ Стоп"), callback_data: TELEGRAM_STOP_CALLBACK }],
  ],
});

// Анимированный лоадер статуса — тот же набор, что у /update
// (t.me/addemoji/iconemoji1), печатающие точки, чтобы «Работаю…» визуально
// отличался от обновления. Без Premium у владельца бота
// Telegram вернёт 400 на custom_emoji — тогда навсегда падаем на обычные ⏳.
const WORK_LOADER = {
  alt: "💬",
  customEmojiId: "5818797194127346654",
  fallback: "⏳",
};
let workLoaderSupported = true;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageIdFromResponse(response: { body: unknown }): number | null {
  const body = asRecord(response.body);
  const result = asRecord(body?.result);
  return typeof result?.message_id === "number" ? result.message_id : null;
}

export async function sendWorkingStatus(
  tg: TelegramStatusHandle,
  { canStop = true } = {},
): Promise<number | null> {
  const base = {
    chat_id: tg.chatId,
    ...(canStop ? { reply_markup: stopReplyMarkup() } : {}),
    ...(tg.messageThreadId !== undefined
      ? { message_thread_id: tg.messageThreadId }
      : {}),
  };
  if (workLoaderSupported) {
    const res = await tg.request("sendMessage", {
      ...base,
      text: `${WORK_LOADER.alt} ${tr("Working…", "Работаю…")}`,
      entities: [
        {
          type: "custom_emoji",
          offset: 0,
          length: WORK_LOADER.alt.length,
          custom_emoji_id: WORK_LOADER.customEmojiId,
        },
      ],
    });
    if (res.ok) return messageIdFromResponse(res);
    workLoaderSupported = false;
  }
  const res = await tg.request("sendMessage", {
    ...base,
    text: `${WORK_LOADER.fallback} ${tr("Working…", "Работаю…")}`,
  });
  return res.ok ? messageIdFromResponse(res) : null;
}

// Терминал хода: state → idle (+wasCancelled), статус-сообщение удалить (обычный финал)
// или переписать на «Остановлено» (отмена). Сбои уборки не критичны — глотаем.
export async function finishTelegramStatus(
  channel: {
    continuationToken: string;
    telegram: TelegramStatusHandle;
  },
  sessionId: string,
  mode: "completed" | "cancelled" | "failed",
): Promise<boolean> {
  const tg = channel.telegram;
  const key = chatKeyOf(tg.chatId, tg.messageThreadId);
  const st = getChatStatus(key);
  // Compare and update happen under one per-chat lock. A reset can remove
  // sessionId after this read; a late terminal event then becomes a no-op.
  if (
    !setChatStatusIf(
      key,
      { sessionId },
      {
        status: "idle",
        continuationToken: toChannelLocalToken(channel.continuationToken),
        sessionId: null,
        turnId: null,
        statusMessageId: null,
        ingressId: null,
        ingressAt: null,
        statusAt: null,
        turnAt: null,
        firstOutputAt: null,
        latencyLogged: null,
        ...(mode === "cancelled" ? { wasCancelled: true } : {}),
      },
    )
  ) {
    return false;
  }
  const msgId = st?.statusMessageId;
  if (typeof msgId !== "number") return true;
  try {
    if (mode === "cancelled") {
      await tg.request("editMessageText", {
        chat_id: tg.chatId,
        message_id: msgId,
        text: stoppedText(),
      });
    } else {
      await tg.request("deleteMessage", {
        chat_id: tg.chatId,
        message_id: msgId,
      });
    }
  } catch {
    /* статус-сообщение не убралось — не критично */
  }
  return true;
}
