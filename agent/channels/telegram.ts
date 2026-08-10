import {
  telegramChannel,
  type TelegramChannelState,
  type TelegramHandle,
  type TelegramMessageBody,
} from "eve/channels/telegram";
import { POST } from "eve/channels";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// Outbox — ЕДИНЫЙ шов наружу (тот же, через который уходят ночные отчёты cron):
// внутри него outbound-Gate, выбор rich/HTML, нарезка на чанки и plain-фолбэк.
import { sendThroughOutbox, type OutboxTransport } from "../lib/outbox.js";
// Inbound-пайплайн — единственный вход внутрь: allowlist, решение о диспатче,
// запись в Vault, медиа со зрением и транскрипцией, inbound-Gate и контекст хода.
// Канал приносит ему эффекты и сам про разбор входящего ничего не знает.
import { runTelegramInbound } from "../lib/telegram-inbound.js";
import { allowedTelegramUsers } from "../lib/telegram-allowlist.js";
import { describeImage } from "../vision.js";
import { transcribe } from "../transcribe.js";
// Статус-сообщение хода («Работаю…», кнопка Стоп, уборка в терминале) и служебное
// объяснение сбоя — UI канала, обе реплики идут мимо Outbox.
import {
  finishTelegramStatus,
  sendWorkingStatus,
  stopReplyMarkup,
  TELEGRAM_STOP_CALLBACK,
} from "../lib/telegram-status-message.js";
import { notifyTelegramFailure } from "../lib/telegram-failure-notice.js";
// Состояние «идёт ли ход» — per-chat файлы data/run-status.d с мостом telegram-poll.mjs:
// мост по ним буферизует входящие, канал хранит sessionId/turnId для отмены.
import {
  chatKeyOf,
  getChatStatus,
  RUN_STALE_MS,
  setChatStatus,
  setChatStatusIf,
} from "../lib/run-status.js";
// Двуязычие: tr(en, ru) отдаёт строку по текущему языку (data/settings.json → env
// AGENT_LANGUAGE).
import { tr } from "../lib/i18n.js";
import { handleTelegramResetRequest } from "../lib/telegram-reset-route.js";
// Eve отдаёт обработчикам событий токен с именем канала впереди, а reset-роут клеит его
// сам. Сохраняем только channel-local вид, иначе /new сбрасывает несуществующий токен (#110).
import { toChannelLocalToken } from "../lib/telegram-continuation-token.js";
import {
  handleAcceptedTelegramWebhook,
  TELEGRAM_ACCEPTANCE_ROUTE,
  wrapTelegramQueueOnMessage,
} from "../lib/telegram-acceptance.js";
import {
  abandonTelegramEarlyStatus,
  emitTelegramTurnLatency,
  markTelegramFirstOutput,
  publishTelegramEarlyStatus,
  publishTelegramTurnStarted,
} from "../../scripts/lib/telegram-turn-start.ts";

// Токен (TELEGRAM_BOT_TOKEN) и секрет вебхука (TELEGRAM_WEBHOOK_SECRET_TOKEN)
// читаются из окружения автоматически.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// --- ESC-остановка хода (аналог ESC в Claude Code) ---
//
// turn.started шлёт «Работаю…» с кнопкой [⏹ Стоп] (agent/lib/telegram-status-message.ts)
// и пишет running+sessionId+turnId в run-status. Нажатие кнопки (или /stop, который мост
// превращает в такой же callback_query) приходит в onCallbackQuery → resumeHook
// "<sessionId>:cancel" → eve абортит ход → turn.cancelled правит статус-сообщение.

// Callback hooks Telegram не получают route-level cancel helper. resumeHook("<sessionId>:cancel")
// абортит активный ход — сигнал прошит до model.stream и тулзов.
// Именно ДИНАМИЧЕСКИЙ import по вычисленному пути: статический компилятор authored-модулей
// eve копирует в свой кэш, где package-internal специфаеры #compiled/* не резолвятся
// (сервис падает на старте). Рантайм-import оставляет модуль на месте (алиасы eve работают),
// а мир Workflow лежит в globalThis-реестре — общий для любых инстансов модуля.
// ПРИ АПГРЕЙДЕ eve: если появился публичный cancel-API — перейти на него.
let resumeHookPromise: Promise<
  (token: string, payload: unknown) => Promise<unknown>
> | null = null;
function loadResumeHook(): Promise<
  (token: string, payload: unknown) => Promise<unknown>
> {
  resumeHookPromise ??= import(
    pathToFileURL(
      join(
        process.cwd(),
        "node_modules/eve/dist/src/internal/workflow/runtime.js",
      ),
    ).href
  ).then((moduleValue: unknown) => {
    const resumeHook = asRecord(moduleValue)?.resumeHook;
    if (typeof resumeHook !== "function") {
      throw new TypeError("eve runtime did not export resumeHook");
    }
    return resumeHook as (token: string, payload: unknown) => Promise<unknown>;
  });
  return resumeHookPromise;
}

// Транспорт Outbox для канала: доставка через хендл eve. Что и в каком виде отдавать,
// решает шов (agent/lib/outbox.ts) — здесь только вызовы Bot API и логи отказов.
// stop канал не выставляет намеренно: ответ в диалоге короткий, и упавший кусок
// не повод молчать остальными. Обрыв хвоста — про ночные отчёты, не про разговор.
function outboxTransport(
  tg: Pick<TelegramHandle, "chatId" | "messageThreadId" | "request" | "post">,
): OutboxTransport {
  return {
    // Rich message (sendRichMessage, Bot API 10.1): таблицы/таск-листы/<details>/формулы
    // рендерятся нативно — HTML-путь так не умеет. Любая ошибка (старый Bot API, парс,
    // лимит 32768, RICH_MESSAGE_*) уводит шов в HTML-путь, то есть в поведение до rich.
    // request() = raw Bot API call, транспорт JSON, поэтому rich_message шлём объектом.
    async sendRich(markdown) {
      try {
        const res = await tg.request("sendRichMessage", {
          chat_id: tg.chatId,
          rich_message: { markdown },
          ...(tg.messageThreadId !== undefined
            ? { message_thread_id: tg.messageThreadId }
            : {}),
        });
        if (res.ok) return { ok: true };
        console.error(
          "[telegram] sendRichMessage отвергнут, фолбэк HTML:",
          res.status,
          JSON.stringify(res.body).slice(0, 300),
        );
        return {
          ok: false,
          error: `sendRichMessage ${res.status}`,
          retryPlain: false,
        };
      } catch (err) {
        console.error("[telegram] sendRichMessage упал, фолбэк HTML:", err);
        return { ok: false, error: String(err), retryPlain: false };
      }
    },
    async sendHtml(html) {
      try {
        // eve's TelegramMessageBody type omits parse_mode, но рантайм
        // (normalizeTelegramMessageBody) спредит тело прямо в sendMessage —
        // поле доходит до Telegram, и от него зависит наш HTML-рендер. Расширяем тип локально.
        await tg.post({
          text: html,
          parse_mode: "HTML",
        } as TelegramMessageBody & { parse_mode: "HTML" });
        return { ok: true };
      } catch (err) {
        console.error(
          "[telegram] HTML отвергнут, шлю plain:",
          err,
          "| HTML:",
          html.slice(0, 300),
        );
        return { ok: false, error: String(err), retryPlain: true };
      }
    },
    async sendPlain(text) {
      try {
        await tg.post(text);
        return { ok: true };
      } catch (e2) {
        console.error("[telegram] plain-фолбэк тоже упал:", e2);
        return { ok: false, error: String(e2), retryPlain: false };
      }
    },
  };
}

const telegram = telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "my_bot",
  // Картинку/файл НЕ суём в запрос к модели (это и ломалось: octet-stream → reject, потом
  // инлайн → Bad Request от провайдера, плюс привязка к конкретному vision-API). "disabled" →
  // eve не качает и не инлайнит вложения вовсе; запрос к модели всегда чистый текст и не
  // ломается ни на каком провайдере. Файлы качает и сохраняет inbound-пайплайн, а модели отдаёт
  // ПУТЬ — посмотреть/прочитать она решает сама своими инструментами; не умеет — честно скажет.
  uploadPolicy: "disabled",
  // Нажатия inline-кнопок, не относящиеся к HITL eve. Мост доставляет их даже когда
  // агент занят (callback_query не буферизуется) — иначе «Стоп» не мог бы дойти.
  async onCallbackQuery(ctx, query) {
    if (query.data !== TELEGRAM_STOP_CALLBACK) return; // чужой колбэк — не наш
    const ack = async (text?: string) => {
      try {
        await ctx.telegram.request("answerCallbackQuery", {
          callback_query_id: query.id,
          ...(text ? { text } : {}),
        });
      } catch {
        /* /stop шлёт синтетический query.id — answerCallbackQuery на него падает, это норма */
      }
    };
    const from = query.from?.id;
    const allowed = allowedTelegramUsers();
    if (allowed.size === 0 || !from || !allowed.has(from)) return ack();
    const ref = query.message;
    if (!ref) return ack();
    const key = chatKeyOf(ref.chat.id, ref.messageThreadId);
    const st = getChatStatus(key);
    const sessionId = st?.sessionId;
    if (
      !st ||
      st.status !== "running" ||
      typeof sessionId !== "string" ||
      sessionId.length === 0
    ) {
      return ack(
        tr("Nothing is running right now.", "Сейчас ничего не выполняется."),
      );
    }
    try {
      // Пустой payload матчит любой активный ход; turnId — гард, чтобы запоздалое
      // нажатие не убило уже СЛЕДУЮЩИЙ ход (несовпавший turnId eve глотает как no-op).
      const resumeHook = await loadResumeHook();
      const turnId = st.turnId;
      await resumeHook(
        `${sessionId}:cancel`,
        typeof turnId === "string" && turnId.length > 0 ? { turnId } : {},
      );
      await ack(tr("Stopping…", "Останавливаю…"));
    } catch (e) {
      console.error("[telegram] cancel-хук не сработал:", e);
      await ack(
        tr(
          "Didn't work — the turn may have already finished.",
          "Не вышло — возможно, ход уже завершился.",
        ),
      );
    }
  },
  events: {
    // Начало хода: сначала публикуем running, затем отправляем медленное статус-сообщение.
    // FIFO-мост не должен успеть принять следующую голову, пока Bot API отвечает.
    async "turn.started"(data, channel, ctx) {
      const tg = channel.telegram;
      await publishTelegramTurnStarted({
        chatKey: chatKeyOf(tg.chatId, tg.messageThreadId),
        continuationToken: toChannelLocalToken(channel.continuationToken),
        sessionId: ctx.session.id,
        turnId: data.turnId,
        getStatusImpl: getChatStatus,
        setStatusIfImpl: setChatStatusIf,
        sendWorkingStatusImpl: (options) => sendWorkingStatus(tg, options),
        enableWorkingStatusStopImpl: (messageId) =>
          tg.request("editMessageReplyMarkup", {
            chat_id: tg.chatId,
            message_id: messageId,
            reply_markup: stopReplyMarkup(),
          }),
        removeWorkingStatusImpl: (messageId) =>
          tg.request("deleteMessage", {
            chat_id: tg.chatId,
            message_id: messageId,
          }),
        onWorkingStatusError: (error) =>
          console.error("[telegram] статус-сообщение не отправилось:", error),
      });
    },
    async "turn.completed"(_data, channel, ctx) {
      await finishTelegramStatus(channel, ctx.session.id, "completed");
    },
    async "turn.cancelled"(_data, channel, ctx) {
      await finishTelegramStatus(channel, ctx.session.id, "cancelled");
    },
    // Страховка: если терминальное turn-событие потерялось (краш), парковка сессии
    // снимает busy-флаг И удаляет осиротевший «Работаю…» — та же уборка, что у
    // turn.completed. После обычного финала CAS по sessionId не совпадает — no-op.
    async "session.waiting"(_data, channel, ctx) {
      await finishTelegramStatus(channel, ctx.session.id, "completed");
    },
    "message.appended"(_data, channel, ctx) {
      markTelegramFirstOutput({
        chatKey: chatKeyOf(
          channel.telegram.chatId,
          channel.telegram.messageThreadId,
        ),
        sessionId: ctx.session.id,
        getStatusImpl: getChatStatus,
        setStatusIfImpl: setChatStatusIf,
      });
    },
    // Ответ модели уходит через Outbox — он же переопределяет дефолтную plain-доставку
    // eve. Промежуточный текст перед tool-calls не шлём (зеркалим дефолт). Повторного
    // хода модели на сбой доставки нет — ход уже закрыт, реформат произойдёт на следующем
    // сообщении (ошибка видна в логе/vault). Латентность засчитываем, только если ушло
    // хотя бы одно сообщение и ни одно не потерялось.
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const recordDelivery = (delivered: boolean) =>
        emitTelegramTurnLatency({
          chatKey: chatKeyOf(
            channel.telegram.chatId,
            channel.telegram.messageThreadId,
          ),
          sessionId: ctx.session.id,
          deliveryAt: Date.now(),
          delivered,
          getStatusImpl: getChatStatus,
          setStatusIfImpl: setChatStatusIf,
        });
      const result = await sendThroughOutbox(
        data.message,
        outboxTransport(channel.telegram),
      );
      if (result.delivered > 0 && result.ok) recordDelivery(true);
    },
    // Ход упал: статус прибираем по CAS, но сообщение об ошибке от него не гейтим —
    // позднее terminal-событие всё равно должно объяснить пользователю, что произошло.
    async "turn.failed"(data, channel, ctx) {
      try {
        await finishTelegramStatus(channel, ctx.session.id, "failed");
      } catch {
        /* run-status не прибрался — сообщение об ошибке всё равно отправляем */
      }
      await notifyTelegramFailure(ctx.session.id, data, (text) =>
        channel.telegram.sendMessage(text),
      );
    },
    // У terminal-сбоя eve следом за turn.failed шлёт session.failed без ctx.
    // Повторно прибираем run-status по sessionId из payload и не дублируем уведомление.
    async "session.failed"(data, channel) {
      if (channel.telegram.chatId) {
        try {
          await finishTelegramStatus(channel, data.sessionId, "failed");
        } catch {
          /* best-effort: отсутствие chat-state не должно ломать уведомление */
        }
      }
      await notifyTelegramFailure(data.sessionId, data, (text) =>
        channel.telegram.sendMessage(text),
      );
    },
  },
  // Вход: канал только подаёт эффекты, разбор апдейта живёт в пайплайне.
  onMessage: wrapTelegramQueueOnMessage((ctx, message) => {
    const tg = ctx.telegram;
    const chatKey = chatKeyOf(message.chat.id, message.messageThreadId);
    let earlyIngressId: string | null = null;
    return runTelegramInbound(message, {
      botUsername: tg.botUsername,
      request: (method, body) => tg.request(method, body),
      sendMessage: (text) => tg.sendMessage(text),
      startTyping: () => tg.startTyping(),
      describeImage,
      transcribe,
      onAccepted: async () => {
        earlyIngressId = await publishTelegramEarlyStatus({
          chatKey,
          staleMs: RUN_STALE_MS,
          getStatusImpl: getChatStatus,
          setStatusIfImpl: setChatStatusIf,
          sendWorkingStatusImpl: (options) => sendWorkingStatus(tg, options),
          removeWorkingStatusImpl: (messageId) =>
            tg.request("deleteMessage", {
              chat_id: tg.chatId,
              message_id: messageId,
            }),
          onWorkingStatusError: (error) =>
            console.error(
              "[telegram] раннее статус-сообщение не отправилось:",
              error,
            ),
        });
      },
      onAbandoned: async () => {
        if (earlyIngressId === null) return;
        await abandonTelegramEarlyStatus({
          chatKey,
          ingressId: earlyIngressId,
          getStatusImpl: getChatStatus,
          setStatusIfImpl: setChatStatusIf,
          removeWorkingStatusImpl: (messageId) =>
            tg.request("deleteMessage", {
              chat_id: tg.chatId,
              message_id: messageId,
            }),
          onWorkingStatusError: (error) =>
            console.error(
              "[telegram] раннее статус-сообщение не удалилось:",
              error,
            ),
        });
      },
      consumeCancelledMark: () => {
        if (!getChatStatus(chatKey)?.wasCancelled) return false;
        setChatStatus(chatKey, { wasCancelled: null });
        return true;
      },
    });
  }),
});

const telegramWebhookRoute = telegram.routes.find(
  (route) =>
    route.transport !== "websocket" &&
    route.method === "POST" &&
    route.path === "/eve/v1/telegram",
);
if (!telegramWebhookRoute || telegramWebhookRoute.transport === "websocket") {
  throw new Error("telegramChannel did not expose its expected webhook route");
}

// The generic eveChannel reset endpoint owns the "eve" continuation namespace,
// while these sessions belong to "telegram". Keep reset on the same authored
// channel so Eve prepends the correct channel name before resolving ownership.
export default {
  ...telegram,
  routes: [
    ...telegram.routes,
    POST<TelegramChannelState>(TELEGRAM_ACCEPTANCE_ROUTE, (request, args) =>
      handleAcceptedTelegramWebhook(
        telegramWebhookRoute.handler,
        request,
        args,
      ),
    ),
    POST("/eve/v1/telegram/reset", (req, { reset }) =>
      handleTelegramResetRequest(
        req,
        reset,
        process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      ),
    ),
  ],
};
