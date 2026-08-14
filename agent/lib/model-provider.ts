// Единственный резолвер MODEL_PROVIDER: имя провайдера, текстовая модель и поддержка
// OpenAI-совместимого reasoning_effort решаются РАЗ и одинаково для рантайма
// (agent/provider.ts) и учёта расхода (agent/hooks/usage.ts).
//
// Выбор fail-closed. Неизвестное значение (опечатка `ollmaa`, лишний пробел, другой
// регистр, пустая строка) валит старт с перечнем принятых имён вместо того, чтобы
// подставить конфигурацию ollama под чужим именем: иначе клиент ходит к одному
// провайдеру, а имя, reasoning и учёт токенов живут от другого (issue #161).
// ОТСУТСТВИЕ переменной — не опечатка, а дефолт: ollama, как было всегда.
// Нормализации нет намеренно: `.trim().toLowerCase()` принял бы значение, которого нет
// ни в одном мастере, и вернул бы ту же расходящуюся правду под другим соусом.
//
// Тот же перечень имён повторён ключами CATALOG в scripts/lib/model-catalog.ts: кнопки
// /model и `iva doctor` грузятся на инсталле, где авторского дерева может не быть
// (ADR-0003), поэтому импортировать этот модуль оттуда нельзя. Разъехаться копии не
// могут — их сверяет scripts/lib/model-catalog.test.ts.
//
// Зависимостей у модуля нет намеренно: он читает env и больше ничего.

type Env = Readonly<Record<string, string | undefined>>;

// Порядок — тот же, что у кнопок мастера (scripts/setup/main.ts: 1-4) и ключей CATALOG,
// поэтому список в ошибке читается как список в интерфейсе.
export const MODEL_PROVIDER_NAMES = [
  "ollama",
  "opencode",
  "codex",
  "openrouter",
] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

export interface ModelProviderSelection {
  readonly name: ModelProviderName;
  readonly model: string;
  // Провайдер понимает reasoning_effort прямо в OpenAI-совместимом chat/completions.
  // Это не то же самое, что providerSupportsReasoning в scripts/lib/model-catalog.ts:
  // codex тоже умеет reasoning, но получает его через providerOptions Responses API.
  readonly compatibleReasoning: boolean;
}

// Record<ModelProviderName, …> держит таблицу полной: новое имя в MODEL_PROVIDER_NAMES
// не соберётся, пока ему не задали модель и ответ про reasoning.
// Экспортируется ради шва: CATALOG в scripts/lib/model-catalog.ts несёт те же modelVar и
// те же дефолты для кнопок /model и мастера, и разъехаться им нельзя — расхождение значит,
// что мастер предлагает не ту модель, которую возьмёт рантайм. Сверяет model-catalog.test.ts.
export const MODEL_PROVIDERS = {
  ollama: {
    modelVar: "OLLAMA_MODEL",
    defaultModel: "deepseek-v4-pro",
    compatibleReasoning: true,
  },
  opencode: {
    modelVar: "OPENCODE_MODEL",
    defaultModel: "deepseek-v4-pro",
    compatibleReasoning: true,
  },
  codex: {
    modelVar: "CODEX_MODEL",
    defaultModel: "gpt-5.5",
    compatibleReasoning: false,
  },
  openrouter: {
    // Слаг модели вида vendor/model (напр. anthropic/claude-sonnet-4.5) — задаётся мастером.
    // Дефолт — лишь заглушка на случай ручного .env; мастер всегда перезапишет живой проверкой.
    modelVar: "OPENROUTER_MODEL",
    defaultModel: "openai/gpt-5.1",
    compatibleReasoning: false,
  },
} as const satisfies Record<
  ModelProviderName,
  { modelVar: string; defaultModel: string; compatibleReasoning: boolean }
>;

// Текст отказа: одно предложение с заданным значением, принятыми именами и починкой.
// Его же собирает `iva doctor` из своей половины перечня — совпадение двух строк
// пинует scripts/cli/doctor.test.ts.
export function invalidModelProviderMessage(raw: string): string {
  return `Invalid MODEL_PROVIDER ${JSON.stringify(raw)}; expected one of: ${MODEL_PROVIDER_NAMES.join(", ")} — run: iva config`;
}

/**
 * Модель провайдера из сырого значения переменной. Одно правило на всех, потому что раньше
 * ответов на один и тот же `.env` было три: рантайм брал пустую строку как есть, экран
 * статуса подставлял дефолт, а экран обновления рисовал «?».
 *
 * Пробелы срезаются, пустое (и пробельное) значение — это «не задано», то есть дефолт
 * провайдера. Свою модель нельзя «стереть», оставив агента без имени модели в запросе.
 *
 * Повторено в scripts/lib/model-catalog.ts (`catalogModel`) для половины, которая грузится
 * без authored tree; равенство двух правил сверяет scripts/lib/model-catalog.test.ts.
 */
export function modelProviderModel(
  name: ModelProviderName,
  raw: string | undefined,
): string {
  const configured = (raw ?? "").trim();
  // Эндпоинт OpenCode ждёт bare-ID — срезаем внутренний UI-префикс "opencode-go/"
  // из дефолта и старых .env. Срез идёт ДО проверки на пустоту: голый "opencode-go/"
  // тоже «не задано», а не пустое имя модели в запросе.
  const stripped =
    name === "opencode" ? configured.replace(/^opencode-go\//, "") : configured;
  return stripped || MODEL_PROVIDERS[name].defaultModel;
}

/**
 * Разрешает MODEL_PROVIDER в одну согласованную тройку «имя · модель · reasoning».
 * Бросает на любом значении, которого нет в MODEL_PROVIDER_NAMES.
 */
export function resolveModelProvider(
  env: Env = process.env,
): ModelProviderSelection {
  const raw = env.MODEL_PROVIDER ?? "ollama";
  if (!(MODEL_PROVIDER_NAMES as readonly string[]).includes(raw))
    throw new Error(invalidModelProviderMessage(raw));

  const name = raw as ModelProviderName;
  return {
    name,
    model: modelProviderModel(name, env[MODEL_PROVIDERS[name].modelVar]),
    compatibleReasoning: MODEL_PROVIDERS[name].compatibleReasoning,
  };
}
