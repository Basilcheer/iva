// Транспорт Outbox для cron-пути: ночные отчёты (rollup, daily-digest) уходят прямым
// fetch к Bot API, без запущенного eve. Разметка, гейт и фолбэки живут в самом шве
// (agent/lib/outbox.ts) — здесь остаются только HTTP-вызов и трактовка ответа Telegram.
//
// Контракт sendTelegramHtml:
//   • model-markdown → валидный Telegram-HTML, режется на чанки ≤4096 (≤1024 для подписи);
//   • каждый чанк шлётся с parse_mode=HTML;
//   • если Telegram вернул 400 (не распарсил сущности) — ОДНА повторная попытка тем же
//     чанком, но без тегов и без parse_mode (так 400 по сущностям невозможен), fellBack=true;
//   • упавший чанк не отменяет остальные: отчёт доезжает настолько, насколько смог,
//     а ok=false с первой ошибкой роняет cron-скрипт ненулевым кодом;
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
  const transport: OutboxTransport = {
    sendHtml: (html) =>
      post(bot, { chat_id: chat, text: html, parse_mode: "HTML" }),
    sendPlain: (text) => post(bot, { chat_id: chat, text }),
  };
  try {
    const { ok, fellBack, error } = await sendThroughOutbox(
      md as string,
      transport,
      { limit: caption ? 1024 : 4096 },
    );
    return { ok, fellBack, error };
  } catch (e) {
    // Шов бросает только на нестроковом md (гейт работает по строке) — контракт
    // «никогда не бросает» держим здесь, у самой границы cron-скриптов.
    return { ok: false, fellBack: false, error: errorMessage(e) };
  }
}
