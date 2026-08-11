// Inbound-Gate на web-поверхности: всё, что приносят web_fetch и web_search,
// проходит тот же санитайзер, что и текст из Telegram (security-gate.ts).
// Открытая страница — недоверенный ввод ровно того же класса, что и пересланное
// сообщение: ADR-0005 требует санитайзер на КАЖДОЙ inbound-поверхности, а до сих
// пор web доезжал до модели сырым.
//
// Политика — warn-and-pass, не блокировка (ADR-0006). Модель обязана увидеть
// страницу, иначе агент перестаёт быть полезным на первой же ложной сработке;
// поэтому контент едет всегда, а при атак-сигнале — обёрнутый injectionWarning().
// Отсюда surface: "web" у санитайзера. Оно значит две вещи разом. Первое: гейт
// отдаёт очищенный текст даже при блокировке — по умолчанию он обнуляет его на
// invisible-flood и wallet-drain, а для страницы это молчаливая потеря
// содержимого (тибетский текст, Брайль, математические глифы — обычный контент,
// а не атака). Второе: правила читают все три языка, на которых агент реально
// читает веб; на блокирующем Telegram-входе такой набор ел бы обычные русские
// просьбы владельца.
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
  return sanitizeInbound(input, maxChars, { surface: "web" });
}

// Потолок текста ошибки. Сообщение фреймворка или провайдера цитирует чужие
// данные (заголовок Location у редиректа, кусок битого JSON), то есть остаётся
// каналом для полезной нагрузки. Диагностике хватает первых строк, а длинный
// хвост в контексте не нужен — режем.
export const WEB_ERROR_MAX_CHARS = 2000;

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

export interface WebGateError {
  error: string;
  warning?: string;
}

function decodePercent(text: string): string {
  // `+` в query-string — штатная запись пробела (form-urlencoded), и модель
  // читает её так же: `?note=ignore+all+previous+instructions` для неё фраза, а
  // для санитайзера по сырому виду — одно слово. Поэтому в куске после `?`
  // плюсы раскрываются вместе с %XX. Вне query `+` — обычный знак («C++»), его
  // не трогаем. Раскрытие живёт только в проверочной копии: сам адрес
  // отдаётся сырым.
  const spaced = text.replace(/\?\S*/gu, (query) => query.replaceAll("+", " "));
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced; // битая escape-последовательность: смотрим только сырой вид
  }
}

// Проверка строки, внутри которой живёт адрес: текста ошибки или url результата
// поиска. Такая строка несёт нагрузку percent-encoded
// (`?note=system:%20ignore%20all%20previous%20instructions`) — санитайзер по
// сырому виду её не видит, а модель читает адрес как обычный текст и декодирует
// сама. Поэтому смотрим оба вида; первый исход — сырой, его текст и отдаётся,
// второй нужен только ради сигнала. Адрес не переписывается: ссылка обязана
// остаться рабочей (ADR-0006).
export function probeWebText(
  text: string,
  maxChars = WEB_ERROR_MAX_CHARS,
): WebGateOutcome[] {
  const raw = gateWebText(text, maxChars);
  const decoded = decodePercent(text);
  return decoded === text ? [raw] : [raw, gateWebText(decoded, maxChars)];
}

// Текст ошибки — тоже web-ввод. Сообщение штатного web_fetch дословно цитирует
// адрес редиректа, а разбор ответа провайдера — кусок его тела: без гейта
// атакующему хватало заголовка `Location`, чтобы доставить инструкцию в модель в
// обход санитайзера. Политика та же, warn-and-pass: причина отказа модели нужна
// (по адресу редиректа она повторит вызов), поэтому текст едет — очищенный, при
// сигнале с warning и одной записью в лог.
export function gateWebError(source: string, message: string): WebGateError {
  const outcomes = probeWebText(message);
  const { warning } = reportWebGate(source, outcomes);
  return { error: outcomes[0].text, ...(warning ? { warning } : {}) };
}
