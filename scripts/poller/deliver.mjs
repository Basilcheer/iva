import {
  addTelegramQueueReceipt,
  TELEGRAM_ACCEPTANCE_KIND_HEADER,
} from "#lib/telegram-acceptance.mjs";
import { classifyDeliverStatus } from "../lib/deliver-policy.ts";
import { tr } from "#lib/i18n.mjs";
import {
  ROUTE,
  ACCEPTANCE_ROUTE,
  SECRET,
  ALLOWED,
  SETTLE_MS,
  sleep,
  log,
} from "./config.ts";
import { tg } from "./transport.ts";
import { chatKey } from "./offset.ts";

// Deliver one update to the local eve (we mimic a webhook). Three failure classes (see
// deliver-policy.ts): retry — network/5xx/408/425/429, fast backoff, forever; config —
// 401/403/404 mean the secret/route is broken, messages must NOT be thrown away, so
// retry forever with a LONG backoff + alert the owner; drop-class (other 4xx) — eve
// не даёт надёжного признака «апдейт битый навсегда» (тот же 409 может быть временным
// конфликтом хука), поэтому и эти статусы ретраятся, но ОГРАНИЧЕННО: DROP_ATTEMPTS
// попыток (~5 минут), затем апдейт выбрасывается, чтобы не заморозить все чаты.
// Direct delivery keeps that policy. Durable queue replay opts into one bounded attempt
// per drain pass: its on-disk head is the retry mechanism, so one bad chat cannot starve
// other queues or Telegram polling.
// Returns true when eve accepted the update, false when it was dropped or retained.
const CONFIG_RETRY_MS = 60_000;
const DROP_ATTEMPTS = 30;
async function deliver(
  update,
  {
    route: requestedRoute,
    acceptedStatus,
    queueReceipt: requestedQueueReceipt,
    retry = true,
    retryAcceptanceTimeout = retry,
    timeoutMs,
    onAcceptanceFailure,
  } = {},
) {
  // The authored acceptance wrapper observes onMessage/send(), but not
  // onCallbackQuery. Message updates therefore use the stronger route by default,
  // while genuine and synthetic callbacks keep the original webhook path.
  const route =
    requestedRoute ??
    (update?.message && !update?.callback_query ? ACCEPTANCE_ROUTE : ROUTE);
  const expectsAcceptance =
    acceptedStatus !== undefined || route === ACCEPTANCE_ROUTE;
  const expectedStatus =
    acceptedStatus ?? (expectsAcceptance ? 204 : undefined);
  const queueReceipt =
    requestedQueueReceipt ?? (expectsAcceptance && Boolean(update?.message));
  const outgoing = queueReceipt ? addTelegramQueueReceipt(update) : update;
  const reportAcceptanceFailure = async (details) => {
    if (!onAcceptanceFailure) return;
    try {
      await onAcceptanceFailure(details);
    } catch (error) {
      log("deliver: direct acceptance failure cleanup failed:", error.message);
    }
  };
  for (let attempt = 1; ; attempt++) {
    let wait = Math.min(15000, 1000 * attempt);
    try {
      const res = await fetch(route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": SECRET,
        },
        body: JSON.stringify(outgoing),
        ...(timeoutMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(timeoutMs) }),
      });
      const acceptanceKind = expectsAcceptance
        ? res.headers.get(TELEGRAM_ACCEPTANCE_KIND_HEADER)
        : null;
      if (
        res.ok &&
        (expectedStatus === undefined || res.status === expectedStatus) &&
        (!expectsAcceptance ||
          acceptanceKind === "turn" ||
          acceptanceKind === "handled")
      ) {
        return acceptanceKind === "handled" ? "handled" : true;
      }
      if (res.ok) {
        if (expectsAcceptance) {
          await reportAcceptanceFailure({
            attempt,
            kind: "protocol",
            status: res.status,
          });
        }
        if (!retry) {
          log(
            `deliver: acceptance route replied ${res.status} without a valid acceptance receipt; queue head retained`,
          );
          return false;
        }
      }
      if (expectsAcceptance && res.status === 503) {
        await reportAcceptanceFailure({
          attempt,
          kind: "dispatch",
          status: res.status,
        });
      }
      const cls = classifyDeliverStatus(res.status, {
        acceptance: expectsAcceptance,
      });
      if (!retry) {
        log(
          `deliver: eve replied ${res.status}; queue head retained for a later pass`,
        );
        return false;
      }
      if (cls === "drop") {
        if (attempt < DROP_ATTEMPTS) {
          log(
            `deliver: eve replied ${res.status} (attempt ${attempt}/${DROP_ATTEMPTS}) — retrying (may be transient)`,
          );
          await sleep(wait);
          continue;
        }
        log(
          `deliver: eve replied ${res.status} ${DROP_ATTEMPTS} times — DROPPING update ${update.update_id}`,
        );
        await notifyDeliverProblem("drop", res.status);
        return false;
      }
      if (cls === "config") {
        // Не дропаем: это конфигурация сломана, а не апдейт. Длинный бэкофф, чтобы не
        // молотить, и алерт владельцу — чинить надо руками (secret/route).
        wait = CONFIG_RETRY_MS;
        await notifyDeliverProblem("config", res.status);
        log(
          `deliver: eve replied ${res.status} (config error, attempt ${attempt}) — retrying in ${wait / 1000}s`,
        );
      } else {
        log(
          `deliver: eve replied ${res.status} (attempt ${attempt}) — retrying`,
        );
      }
    } catch (e) {
      const acceptanceTimeout =
        expectsAcceptance &&
        (e?.name === "TimeoutError" || e?.name === "AbortError");
      if (acceptanceTimeout) {
        await reportAcceptanceFailure({
          attempt,
          kind: "timeout",
          status: "timeout",
        });
      }
      if (!retry) {
        log(
          `deliver: eve unavailable (${e.message}); queue head retained for a later pass`,
        );
        return false;
      }
      if (acceptanceTimeout && !retryAcceptanceTimeout) {
        // A timed-out POST may still start later. Re-posting it could duplicate the
        // turn, so direct acceptance timeouts are definitive and never retried.
        log(
          `deliver: direct acceptance timed out after ${timeoutMs}ms; rejecting update ${update.update_id} without retry`,
        );
        return false;
      }
      if (acceptanceTimeout) {
        if (attempt < DROP_ATTEMPTS) {
          log(
            `deliver: acceptance timed out (attempt ${attempt}/${DROP_ATTEMPTS}) — retrying`,
          );
          await sleep(wait);
          continue;
        }
        log(
          `deliver: acceptance timed out ${DROP_ATTEMPTS} times — DROPPING update ${update.update_id}`,
        );
        await notifyDeliverProblem("drop", "timeout");
        return false;
      }
      log(
        `deliver: eve unavailable (${e.message}, attempt ${attempt}) — waiting for server`,
      );
    }
    await sleep(wait);
  }
}

// Владелец должен узнать и о выброшенном апдейте, и о конфиг-ошибке (secret/route).
// Один раз на процесс и класс — чтобы серия ошибок не превратилась в спам. Класс
// помечается «уведомлённым» только ПОСЛЕ успешной отправки: упавший sendMessage не
// должен навсегда лишать владельца алерта.
const deliverNotified = new Set();
async function notifyDeliverProblem(kind, status) {
  if (deliverNotified.has(kind)) return;
  const target = process.env.TELEGRAM_DIGEST_CHAT_ID || [...ALLOWED][0];
  if (!target) return;
  const text =
    kind === "config"
      ? tr(
          `⚠️ Iva bridge can't deliver to eve: HTTP ${status} — the webhook secret or route looks broken. Messages are queued (retrying every 60s). Check: journalctl --user -u iva-telegram-poll`,
          `⚠️ Мост Iva не может доставить в eve: HTTP ${status} — похоже, разъехались webhook-секрет или маршрут. Сообщения не теряются (ретрай раз в 60с). Проверь: journalctl --user -u iva-telegram-poll`,
        )
      : tr(
          `⚠️ Iva bridge dropped a Telegram update: eve replied ${status} (permanent). Check the logs: journalctl --user -u iva-telegram-poll`,
          `⚠️ Мост Iva выбросил Telegram-апдейт: eve ответила ${status} (постоянная ошибка). Проверь логи: journalctl --user -u iva-telegram-poll`,
        );
  try {
    const res = await tg("sendMessage", { chat_id: target, text });
    if (res?.ok) deliverNotified.add(kind);
  } catch (e) {
    log("deliver notification failed:", e.message);
  }
}

// Время последней доставки по chat key — для паузы SETTLE_MS между апдейтами одного чата.
// МОДУЛЬ-уровень (не локальная в main): её обязан обновлять и синтетический deliver меню
// (дистилляция интервью), иначе реальное сообщение сразу после него ушло бы без паузы —
// в окно, пока eve ещё не записала run-status и не зарегистрировала continuation-hook →
// второй ран на том же токене → HookConflictError.
const lastDeliverAt = new Map();

// Доставка с пейсингом: выдержать SETTLE_MS с последней доставки в этот чат, доставить,
// отметить время. ЕДИНЫЙ путь для главного цикла и для меню (deps.deliver) — оба делят
// lastDeliverAt, поэтому доставка из меню сдвигает паузу для следующего реального сообщения.
async function pacedDeliver(update, options) {
  const deadline =
    options?.timeoutMs === undefined
      ? null
      : Date.now() + Math.max(0, options.timeoutMs);
  const key = chatKey(update);
  if (key !== null && SETTLE_MS > 0) {
    const prev = lastDeliverAt.get(key);
    if (prev !== undefined) {
      const wait = SETTLE_MS - (Date.now() - prev);
      if (wait > 0) {
        if (deadline !== null && wait >= deadline - Date.now()) return false;
        await sleep(wait);
      }
    }
  }
  const deliverOptions =
    deadline === null
      ? options
      : {
          ...options,
          timeoutMs: Math.max(1, Math.floor(deadline - Date.now())),
        };
  const accepted = await deliver(update, deliverOptions); // wait for delivery — ordered and lossless
  if (key !== null) lastDeliverAt.set(key, Date.now());
  return accepted; // false = апдейт выброшен как битый, eve его НЕ получила
}

export { deliver, notifyDeliverProblem, pacedDeliver };
