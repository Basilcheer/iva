// Транспорт Outbox для cron-пути: ночные отчёты (rollup, daily-digest) уходят прямым
// fetch к Bot API, без запущенного eve. Разметка, гейт и фолбэки живут в самом шве
// (agent/lib/outbox.ts) — здесь остаются только HTTP-вызов и трактовка ответа Telegram.
//
// Контракт sendTelegramHtml:
//   • model-markdown → валидный Telegram-HTML, режется на чанки ≤4096 (≤1024 для подписи);
//   • каждый чанк шлётся с parse_mode=HTML;
//   • если Telegram вернул 400 (не распарсил сущности) — ОДНА повторная попытка тем же
//     чанком, но без тегов и без parse_mode (так 400 по сущностям невозможен), fellBack=true;
//   • любой другой отказ обрывает отчёт: ok=false с первой ошибкой роняет cron-скрипт
//     ненулевым кодом, а оставшиеся чанки Telegram не получает;
//   • пустой отчёт — тоже ok=false: слать нечего, и молчать об этом нельзя;
//   • НИКОГДА не бросает — на любую ошибку возвращает { ok:false, error }.
// Возвращает { ok, fellBack, error } — вызывающий cron-скрипт по fellBack даёт агенту
// обратную связь в ту же сессию, чтобы он переформатировал следующий отчёт.
import {
  sendThroughOutbox,
  type OutboxAck,
  type OutboxTransport,
} from "../../agent/lib/outbox.ts";

type TelegramRequest = Record<string, unknown>;

// Сообщение брошенной ошибки: у fetch-сбоя оно информативнее, чем String(error).
function errorMessage(e: unknown): string {
  return String(
    e !== null &&
      (typeof e === "object" || typeof e === "function") &&
      "message" in e
      ? (e.message ?? e)
      : e,
  );
}

async function post(bot: string, body: TelegramRequest): Promise<OutboxAck> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    // 400 = Telegram не распарсил HTML: единственный статус, где повтор без тегов помогает.
    return {
      ok: false,
      error: `${res.status}: ${await res.text()}`,
      retryPlain: res.status === 400,
    };
  } catch (e) {
    return { ok: false, error: errorMessage(e), retryPlain: false };
  }
}

export async function sendTelegramHtml(
  bot: string,
  chat: string,
  md: unknown,
  { caption = false }: { caption?: boolean } = {},
): Promise<{ ok: boolean; fellBack: boolean; error: string }> {
  // Ночной отчёт — цельный документ, а не диалог: если Telegram отказал не по разметке
  // (flood control, 5xx, бот заблокирован), остаток слать некуда и незачем — добитый
  // 429 продлевает throttle на весь токен, общий с интерактивным каналом. Помечаем
  // такой отказ как stop, и шов бросает хвост — ровно как cron-путь делал до шва.
  const transport: OutboxTransport = {
    sendHtml: async (html) => {
      const ack = await post(bot, {
        chat_id: chat,
        text: html,
        parse_mode: "HTML",
      });
      return ack.ok || ack.retryPlain ? ack : { ...ack, stop: true };
    },
    // Повтор без разметки — последний шанс этого чанка. Не вышел и он: дальше по
    // отчёту идти не с чем, каким бы кодом Telegram ни ответил.
    sendPlain: async (text) => {
      const ack = await post(bot, { chat_id: chat, text });
      return ack.ok ? ack : { ...ack, stop: true };
    },
  };
  try {
    const { ok, delivered, fellBack, error } = await sendThroughOutbox(
      md as string,
      transport,
      { limit: caption ? 1024 : 4096 },
    );
    // Пустой отчёт шов наружу не несёт — Telegram такой текст всё равно отвергает.
    // Но и тишиной это не прикрываем: ночной скрипт должен упасть ненулевым кодом,
    // как падал на 400 «message text is empty», иначе сломанный rollup незаметен.
    if (ok && delivered === 0)
      return { ok: false, fellBack, error: "empty report" };
    return { ok, fellBack, error };
  } catch (e) {
    // Шов бросает только на нестроковом md (гейт работает по строке) — контракт
    // «никогда не бросает» держим здесь, у самой границы cron-скриптов.
    return { ok: false, fellBack: false, error: errorMessage(e) };
  }
}
