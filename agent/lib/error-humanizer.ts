// Сбой хода словами для владельца: что случилось и что делать. Ни стека, ни кода, ни
// Error id — они остаются в журнале сервиса и в Trace (agent/hooks/trace.ts). Текст
// провайдера в чат не идёт вовсе: им некому читать, а секрет в нём — лишний риск.
//
// Попытки и «ответ уже начался» приходят из eve в details (patches/eve:
// runModelCallWithRetries кладёт attempts и answerStarted). Обрыв до первой части ответа eve
// уже повторила сама, до трёх запросов; обрыв посреди ответа она не повторяет — решает
// владелец кнопкой «Повторить» (решение владельца 07.10.2026).

export interface ProviderErrorText {
  readonly en: string;
  readonly ru: string;
}

interface ProviderErrorInput {
  readonly message: string;
  readonly details?: unknown;
  /** MODEL_PROVIDER установки: по нему сообщение называет, с кем пропала связь. */
  readonly provider?: string | undefined;
}

/** Имя провайдера в трёх падежах: «Anthropic не принял», «до Anthropic», «с Anthropic». */
interface ProviderName {
  readonly en: string;
  readonly nom: string;
  readonly gen: string;
  readonly ins: string;
}

const NAMED: Readonly<Record<string, string>> = {
  claude: "Anthropic",
  codex: "OpenAI",
  ollama: "Ollama",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
};

function providerName(provider: string | undefined): ProviderName {
  const name = provider === undefined ? undefined : NAMED[provider];
  return name === undefined
    ? {
        en: "the provider",
        nom: "Провайдер",
        gen: "провайдера",
        ins: "провайдером",
      }
    : { en: name, nom: name, gen: name, ins: name };
}

const RETRY_WRAPPER =
  /^\s*AI_RetryError:\s*Failed after \d+ attempts?\.\s*Last error:\s*/iu;

function detailsText(details: unknown): string {
  if (typeof details === "string") return details;
  if (details === undefined || details === null) return "";
  try {
    return JSON.stringify(details);
  } catch {
    return "";
  }
}

function detailsRecord(details: unknown): Record<string, unknown> {
  return typeof details === "object" &&
    details !== null &&
    !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

function resetAfter(text: string): string | undefined {
  const match = /resets\s+in\s+([^.;\n"'}`\]]+)/iu.exec(text);
  const reset = match?.[1]?.trim();
  return reset ? reset : undefined;
}

/** Сколько раз eve спросила ещё раз: попыток минус первая. */
function repeatsOf(details: Record<string, unknown>): number {
  const attempts = details.attempts;
  return typeof attempts === "number" &&
    Number.isInteger(attempts) &&
    attempts > 1
    ? attempts - 1
    : 0;
}

function timesRu(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "раза";
  return "раз";
}

/** «повторила 2 раза, не получилось» — только если повторы были. */
function repeated(count: number): ProviderErrorText {
  if (count === 0) return { en: "", ru: "" };
  return {
    en: ` I tried again ${String(count)} ${count === 1 ? "time" : "times"}, it did not work.`,
    ru: `, повторила ${String(count)} ${timesRu(count)}, не получилось`,
  };
}

/** Кнопка под сообщением: нажатие приходит ходу текстом data и текстом сообщения. */
function retryButton(label: string): string {
  return `<tg-button-row><tg-button type="callback_data" data="${label}">${label}</tg-button></tg-button-row>`;
}

const LIMIT = /usage\s+limit\s+reached|rate[ _-]?limit|\b429\b/iu;
const TOOL_SCHEMA = /invalid[ _-]?json[ _-]?schema/iu;
const BILLING = /insufficient[ _-]?credits|billing|\b402\b/iu;
const AUTH =
  /invalid[ _-]?api[ _-]?key|unauthorized|authentication|\b(?:401|403)\b/iu;
const CONTEXT = /context\s+length|too\s+many\s+tokens|maximum\s+context/iu;
const UNREACHABLE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED/u;
const PROVIDER_SIDE =
  /upstream\s+request\s+failed|\b5(?:\d{2}|xx)\b|overloaded|internal\s+server\s+error/iu;
const CONNECTION =
  /did not finish the response|broke off|StreamTruncated|connection .{0,40}lost|terminated|socket hang up|other side closed|ECONNRESET|EPIPE|UND_ERR|network request failed|fetch\s+failed|timeout|ETIMEDOUT|stream(?:\s+was)?\s+aborted|no answer reached/iu;

type Situation = {
  readonly evidence: string;
  readonly details: Record<string, unknown>;
  readonly name: ProviderName;
};
type Rule = {
  readonly when: (situation: Situation) => boolean;
  readonly say: (situation: Situation) => ProviderErrorText;
};

function limitText({ evidence }: Situation): ProviderErrorText {
  const reset = resetAfter(evidence);
  return reset
    ? {
        en: `Provider limit exhausted - resets in ${reset}; wait or switch models: /model`,
        ru: `Лимит провайдера исчерпан - сброс через ${reset}; подожди или смени модель: /model`,
      }
    : {
        en: "Provider limit exhausted - wait or switch models: /model",
        ru: "Лимит провайдера исчерпан - подожди или смени модель: /model",
      };
}

// OpenAI отвергает весь запрос из-за схемы одного инструмента (`param: tools`, в тексте
// путь до поля). Инструмент может быть свой (data/custom/agent/tools), из плагина или из
// подключения. Пользователю нужно место и действие, не текст ошибки.
function toolSchemaText({ evidence }: Situation): ProviderErrorText {
  const at = /found at\s+(\$[^\s.]*(?:\.[^\s]+)*)/iu.exec(evidence)?.[1];
  const where = at ? ` (${at})` : "";
  return {
    en: `The provider rejected a tool description${where} - remove that tool from data/custom/agent/tools or switch its plugin off (iva plugin list, iva plugin disable <name>), then /update`,
    ru: `Провайдер не принял описание инструмента${where} - убери этот инструмент из data/custom/agent/tools или выключи его плагин (iva plugin list, iva plugin disable <имя>), затем /update`,
  };
}

function midAnswerText({ name }: Situation): ProviderErrorText {
  return {
    en: `The connection to ${name.en} broke off in the middle of the answer. Try again?\n\n${retryButton("Try again")}`,
    ru: `Связь с ${name.ins} оборвалась на середине ответа. Повторить?\n\n${retryButton("Повторить")}`,
  };
}

function unreachableText({ name, details }: Situation): ProviderErrorText {
  const again = repeated(repeatsOf(details));
  return {
    en: `I cannot reach ${name.en}: the server has no connection to it.${again.en} Check the server's internet and write again.`,
    ru: `Не могу достучаться до ${name.gen}: у сервера нет связи с ним${again.ru}. Проверь интернет на сервере и напиши ещё раз.`,
  };
}

function providerSideText({ name, details }: Situation): ProviderErrorText {
  const again = repeated(repeatsOf(details));
  return {
    en: `${name.en === "the provider" ? "The provider" : name.en} has a failure on its side.${again.en} Write again in a couple of minutes.`,
    ru: `У ${name.gen} сбой${again.ru}. Напиши ещё раз через пару минут.`,
  };
}

function connectionText({ name, details }: Situation): ProviderErrorText {
  const again = repeated(repeatsOf(details));
  return {
    en: `The connection to ${name.en} broke off.${again.en} Write again.`,
    ru: `Связь с ${name.ins} оборвалась${again.ru}. Напиши ещё раз.`,
  };
}

// Порядок — по смыслу для владельца: сначала то, что повтором не лечится (лимит, деньги,
// ключ, схема, переполнение), потом обрыв посреди ответа (кнопка), потом связь.
const RULES: readonly Rule[] = [
  { when: ({ evidence }) => LIMIT.test(evidence), say: limitText },
  { when: ({ evidence }) => TOOL_SCHEMA.test(evidence), say: toolSchemaText },
  {
    when: ({ evidence }) => BILLING.test(evidence),
    say: () => ({
      en: "Provider balance/plan exhausted - top up or switch models: /model",
      ru: "Баланс/тариф провайдера исчерпан - пополни или смени модель: /model",
    }),
  },
  {
    when: ({ evidence }) => AUTH.test(evidence),
    say: ({ name }) => ({
      en: `${name.en === "the provider" ? "The provider" : name.en} did not accept the key or login. Check it in /menu and write again.`,
      ru: `${name.nom} не принял ключ или вход. Проверь его в /menu и напиши ещё раз.`,
    }),
  },
  {
    when: ({ evidence }) => CONTEXT.test(evidence),
    say: () => ({
      en: "The conversation got too long for the model. /new starts over.",
      ru: "Разговор стал слишком длинным для модели. /new начнёт заново.",
    }),
  },
  { when: ({ details }) => details.answerStarted === true, say: midAnswerText },
  { when: ({ evidence }) => UNREACHABLE.test(evidence), say: unreachableText },
  {
    when: ({ evidence }) => PROVIDER_SIDE.test(evidence),
    say: providerSideText,
  },
  { when: ({ evidence }) => CONNECTION.test(evidence), say: connectionText },
];

function unknownText({ name }: Situation): ProviderErrorText {
  return {
    en: `I could not answer: ${name.en} returned something I could not read. Write again; if it repeats, /new starts over.`,
    ru: `Не получилось ответить: ${name.nom} вернул ответ, который я не разобрала. Напиши ещё раз; если повторится, /new начнёт заново.`,
  };
}

export function humanizeProviderError({
  message,
  details,
  provider,
}: ProviderErrorInput): ProviderErrorText {
  const situation: Situation = {
    evidence: `${message.replace(RETRY_WRAPPER, "")}\n${detailsText(details)}`,
    details: detailsRecord(details),
    name: providerName(provider),
  };
  const rule = RULES.find((candidate) => candidate.when(situation));
  return (rule?.say ?? unknownText)(situation);
}
