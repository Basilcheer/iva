// Сообщение о падении хода. У terminal-сбоя eve присылает и turn.failed, и
// session.failed — оба несут одну и ту же беду, но пользователь должен увидеть её
// один раз. Заявка на уведомление берётся по sessionId и живёт TTL; не ушедшее
// сообщение освобождает заявку, чтобы следующее событие всё-таки объяснило сбой.
//
// Это служебная реплика канала, а не текст модели: мимо Outbox.
import { humanizeProviderError } from "./error-humanizer.ts";
import { tr } from "./i18n.ts";

export type TelegramFailureData = { message: string; details?: unknown };

const FAILURE_NOTIFICATION_TTL_MS = 60_000;
const failureNotifications = new Map<string, number>();

function pruneFailureNotifications(now: number): void {
  for (const [sessionId, notifiedAt] of failureNotifications) {
    if (now - notifiedAt >= FAILURE_NOTIFICATION_TTL_MS) {
      failureNotifications.delete(sessionId);
    }
  }
}

function claimFailureNotification(
  sessionId: string,
  now: number,
): number | null {
  pruneFailureNotifications(now);
  const notifiedAt = failureNotifications.get(sessionId);
  if (
    notifiedAt !== undefined &&
    now - notifiedAt < FAILURE_NOTIFICATION_TTL_MS
  ) {
    return null;
  }
  failureNotifications.set(sessionId, now);
  return now;
}

function releaseFailureNotification(sessionId: string, claim: number): void {
  if (failureNotifications.get(sessionId) === claim) {
    failureNotifications.delete(sessionId);
  }
}

function extractFailureErrorId(details: unknown): string | undefined {
  if (
    typeof details !== "object" ||
    details === null ||
    Array.isArray(details)
  ) {
    return undefined;
  }
  const errorId = (details as Record<string, unknown>).errorId;
  return typeof errorId === "string" && errorId.length > 0
    ? errorId
    : undefined;
}

export function telegramFailureMessage(data: TelegramFailureData): string {
  const text = humanizeProviderError(data);
  const errorId = extractFailureErrorId(data.details);
  return [
    tr(text.en, text.ru),
    ...(errorId ? ["", `Error id: ${errorId}`] : []),
  ].join("\n");
}

// Отправляет объяснение сбоя ровно один раз на сессию. Сбой самой отправки
// глотаем: сообщение об ошибке не повод рушить обработчик события.
export async function notifyTelegramFailure(
  sessionId: string,
  data: TelegramFailureData,
  send: (text: string) => Promise<unknown>,
  { now = Date.now() }: { now?: number } = {},
): Promise<void> {
  const claim = claimFailureNotification(sessionId, now);
  if (claim === null) return;
  try {
    await send(telegramFailureMessage(data));
  } catch {
    releaseFailureNotification(sessionId, claim);
    /* молча игнорируем сбой ответа */
  }
}
