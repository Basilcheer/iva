// Inbound-Gate на web-поверхности: всё, что приносят web_fetch и web_search,
// проходит тот же санитайзер, что и текст из Telegram (security-gate.ts).
// Открытая страница — недоверенный ввод ровно того же класса, что и пересланное
// сообщение: ADR-0005 требует санитайзер на КАЖДОЙ inbound-поверхности, а до сих
// пор web доезжал до модели сырым.
//
// Политика — warn-and-pass, не блокировка (ADR-0006). Модель обязана увидеть
// страницу, иначе агент перестаёт быть полезным на первой же ложной сработке;
// поэтому контент едет всегда, а при атак-сигнале — обёрнутый injectionWarning().
// Отсюда keepBlockedText: санитайзер по умолчанию обнуляет текст на
// invisible-flood и wallet-drain, что для страницы означает молчаливую потерю
// содержимого (тибетский текст, Брайль, математические глифы — обычный контент, а не
// атака). Мы забираем очищенный текст и помечаем его.
//
// Порядок: сеть → усечение силами eve (свой бюджет вывода тула) → санитайзер.
// Санитайзер стоит последним, чтобы модели доставался ровно тот текст, который
// он проверил; его собственный лимит здесь — подстраховка, а не рабочий кап.
import {
  hasInboundAttackSignal,
  sanitizeInbound,
  type SanitizeResult,
} from "./security-gate.ts";
import {
  inboundTruncationNotice,
  injectionWarning,
} from "./telegram-gate-notice.ts";

// Потолок текста с одной web-поверхности. Выбран не меньше бюджета вывода тула у
// eve (50 KB / 2000 строк), чтобы гейт не резал то, что фреймворк уже отдал
// целиком, и одновременно ограничивал вход, если бюджет когда-нибудь вырастет.
export const WEB_TEXT_MAX_CHARS = 50_000;

export type WebGateOutcome = SanitizeResult;

// Один кусок web-текста через санитайзер. Чистая функция: решение о логе и
// предупреждении принимает reportWebGate, чтобы на один вызов тула приходилась
// одна запись в лог, а не по одной на каждый сниппет.
export function gateWebText(
  input: string,
  maxChars = WEB_TEXT_MAX_CHARS,
): WebGateOutcome {
  return sanitizeInbound(input, maxChars, { keepBlockedText: true });
}

export interface WebGateReport {
  flagged: boolean;
  // Предупреждение модели: непусто ровно тогда, когда flagged.
  warning?: string;
  // Пометка об усечении защитным лимитом (полной записи у web нет — только счёт).
  truncationNotice?: string;
}

// Сводит результаты по всем кускам одного вызова тула: один console.error и одно
// предупреждение на ответ. Формат лога общий с Telegram-входом
// (agent/lib/telegram-inbound.ts) — иначе одно и то же событие пришлось бы
// искать в логах двумя разными грепами.
export function reportWebGate(
  source: string,
  outcomes: readonly WebGateOutcome[],
): WebGateReport {
  const flaggedOutcomes = outcomes.filter((outcome) =>
    hasInboundAttackSignal(outcome),
  );
  const truncatedChars = outcomes.reduce(
    (total, outcome) => total + outcome.truncatedChars,
    0,
  );
  const truncationNotice =
    inboundTruncationNotice({ truncatedChars }) ?? undefined;

  if (flaggedOutcomes.length === 0) {
    return {
      flagged: false,
      ...(truncationNotice ? { truncationNotice } : {}),
    };
  }

  // reason у непрошедшего порог блокировки куска — "clean"; в лог он не нужен,
  // сигнал в этом случае несут флаги.
  const reasons =
    [
      ...new Set(
        flaggedOutcomes
          .map((outcome) => outcome.reason)
          .filter((reason) => reason !== "clean"),
      ),
    ].join("; ") || "attack signal";
  const flags = [
    ...new Set(flaggedOutcomes.flatMap((outcome) => outcome.flags)),
  ].join(",");
  console.error(`[security] web inbound flagged (${source}):`, reasons, flags);

  return {
    flagged: true,
    warning: injectionWarning(),
    ...(truncationNotice ? { truncationNotice } : {}),
  };
}
