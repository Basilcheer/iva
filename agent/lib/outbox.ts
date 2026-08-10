// Outbox — единственный шов наружу. Всё, что агент говорит в Telegram, проходит
// здесь: ответ модели из Channel (agent/channels/telegram.ts) и ночные отчёты
// cron-скриптов (scripts/lib/telegram-send.ts). Внутри шва живут outbound-Gate,
// маршрутизация в rich-сообщение, нарезка на HTML-чанки и plain-фолбэк — снаружи
// остаётся только транспорт Bot API, свой у каждого пути. Новый путь наружу
// пишется как OutboxTransport, и обойти гейт по дороге больше нечем.
//
// Служебные реплики самого harness (статус «Работаю…», ack на кнопку, уведомление
// о падении хода) идут мимо шва: это не текст модели, а UI канала.
//
// Импорты с расширением .ts намеренно: модуль грузится не только из eve-бандла, но
// и голым node (cron → scripts/lib/telegram-send.ts), где «./x.js» → «./x.ts» никто
// не переписывает.
import { scanOutbound } from "./security-gate.ts";
import {
  htmlToPlain,
  needsRichMessage,
  toTelegramHtmlChunks,
} from "./telegram-format.ts";

// Ответ транспорта на одну попытку доставки. retryPlain=true — Telegram не принял
// разметку (400 по сущностям), тот же кусок имеет смысл повторить без тегов;
// retryPlain=false — этот кусок безнадёжен, шов идёт к следующему.
export type OutboxAck =
  { ok: true } | { ok: false; error: string; retryPlain: boolean };

export type OutboxTransport = {
  sendHtml: (html: string) => Promise<OutboxAck>;
  sendPlain: (text: string) => Promise<OutboxAck>;
  // Только там, где Bot API это умеет (sendRichMessage): таблицы, таск-листы,
  // <details>, блочные формулы. Без него шов сразу идёт HTML-путём.
  sendRich?: (markdown: string) => Promise<OutboxAck>;
};

export type OutboxResult = {
  ok: boolean; // всё, что шов начал отправлять, доставлено
  delivered: number; // сколько сообщений реально ушло в чат
  fellBack: boolean; // хотя бы один кусок ушёл без разметки
  error: string; // первый отказ доставки (дальше шов всё равно дошёл до конца)
};

export async function sendThroughOutbox(
  message: string,
  transport: OutboxTransport,
  { limit = 4096 }: { limit?: number } = {},
): Promise<OutboxResult> {
  // Outbound-гейт: редактим утёкшие секреты и эксфил-URL ДО отправки. Fail-open —
  // нашли что-то, шлём отредактированное и громко логируем (блокировать ответ
  // целиком хуже редкой утечки для единственного владельца инсталляции).
  const guard = scanOutbound(message);
  if (!guard.clean)
    console.error(
      "[security] outbound leak redacted:",
      guard.findings.map((f) => `${f.type}:${f.name}`).join(", "),
    );

  const result: OutboxResult = {
    ok: true,
    delivered: 0,
    fellBack: false,
    error: "",
  };

  // Rich-путь рендерит нативно то, чего parse_mode=HTML не умеет. Любой отказ —
  // просто HTML-путь ниже, то есть худший случай равен обычному поведению.
  if (transport.sendRich && needsRichMessage(guard.text)) {
    const rich = await transport.sendRich(guard.text);
    if (rich.ok) {
      result.delivered = 1;
      return result;
    }
  }

  // Отказ на одном куске не отменяет остальные: длинный ответ рвётся на чанки
  // произвольно, и на 429/сетевом блипе посреди хвоста пользователю лучше получить
  // остаток ответа, чем тишину. Первую ошибку запоминаем, ok=false — этого хватает
  // вызывающим (cron выходит ненулевым кодом, канал не засчитывает латентность).
  const fail = (error: string) => {
    if (result.ok) result.error = error;
    result.ok = false;
  };

  // toTelegramHtmlChunks режет И конвертирует, гарантируя длину каждого чанка
  // ≤limit ПОСЛЕ конвертации. Пустые чанки не шлём: Telegram отвергает пустой текст.
  for (const html of toTelegramHtmlChunks(guard.text, limit)) {
    if (!html) continue;
    const sent = await transport.sendHtml(html);
    if (sent.ok) {
      result.delivered++;
      continue;
    }
    if (!sent.retryPlain) {
      fail(sent.error);
      continue;
    }
    // Один повтор тем же куском, но без тегов и parse_mode — по сущностям 400
    // тогда невозможен. htmlToPlain декодирует сущности, иначе &amp; уйдёт литералом.
    result.fellBack = true;
    const plain = await transport.sendPlain(htmlToPlain(html));
    if (plain.ok) result.delivered++;
    else fail(`plain retry ${plain.error}`);
  }
  return result;
}
