type Env = Record<string, string | undefined>;

type ProviderSettings = {
  label: string;
  model: string;
  context: string;
};

// Короткие подписи для одной строки статуса — не лейблы каталога (там «Ollama Cloud»).
// Имена — те же, что принимает рантайм, и ровно те же: лишнее имя здесь показало бы
// провайдера, на котором агент не стартует, а недостающее назвало бы рабочего невалидным.
// Обе стороны сверяет update-ui.test.ts.
export const PROVIDERS: Record<string, ProviderSettings> = {
  ollama: {
    label: "Ollama",
    model: "OLLAMA_MODEL",
    context: "OLLAMA_CONTEXT_WINDOW",
  },
  opencode: {
    label: "OpenCode",
    model: "OPENCODE_MODEL",
    context: "OPENCODE_CONTEXT_WINDOW",
  },
  openrouter: {
    label: "OpenRouter",
    model: "OPENROUTER_MODEL",
    context: "OPENROUTER_CONTEXT_WINDOW",
  },
  codex: {
    label: "OpenAI",
    model: "CODEX_MODEL",
    context: "CODEX_CONTEXT_WINDOW",
  },
};

/** Display-only model settings. Setup writes explicit values, so this helper never duplicates runtime defaults. */
export function modelSummary(env: Env = process.env): {
  provider: string;
  model: string;
  contextWindow: number | null;
  line: string;
} {
  // Строгое совпадение, как в рантайме (agent/lib/model-provider.ts): привести здесь
  // регистр или обрезать пробелы значило бы назвать провайдера, на котором агент даже
  // не стартует. Неизвестное имя показываем тем же словом, что и /menu → Статус.
  const id = env.MODEL_PROVIDER ?? "ollama";
  const provider = Object.hasOwn(PROVIDERS, id)
    ? PROVIDERS[id]
    : { label: `invalid (${id})`, model: "", context: "" };
  const model = provider.model ? (env[provider.model] || "?").trim() : "?";
  const rawContext = provider.context ? Number(env[provider.context]) : 0;
  return {
    provider: provider.label,
    model,
    contextWindow:
      Number.isFinite(rawContext) && rawContext > 0 ? rawContext : null,
    line: `${provider.label} · ${model}`,
  };
}

export function compactNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "?";
  }
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}k`;
  return new Intl.NumberFormat("en-US").format(value);
}
