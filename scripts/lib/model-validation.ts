import {
  CATALOG,
  ModelCatalogError,
  fetchModelOptions,
} from "./model-catalog.ts";

type OpenRouterErrorReason = (body: unknown, status: number) => unknown;
type ModelSelection = {
  provider: string;
  model: string | null | undefined;
  key?: string;
  dataDir?: string;
};
type ValidationOptions = {
  fetchFn?: typeof fetch;
  listCodexCatalog?: (options?: {
    dataDir?: string;
  }) => Promise<{ id: string; reasoningLevels: string[] }[]>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const FETCH_TIMEOUT_MS = 10_000;

export class ModelValidationError extends Error {
  declare readonly code: string;
  declare readonly status?: number;

  constructor(
    code: string,
    message: string,
    { status, cause }: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = "ModelValidationError";
    this.code = code;
    this.status = status;
  }
}

const validationError = (error: unknown): ModelValidationError => {
  if (error instanceof ModelValidationError) return error;
  if (error instanceof ModelCatalogError) {
    return new ModelValidationError(error.code, error.message, {
      status: error.status,
      cause: error,
    });
  }
  return new ModelValidationError(
    "catalog_unavailable",
    "provider validation failed",
    {
      cause: error,
    },
  );
};

export async function probeOpenRouterModel(
  { model, key }: { model: string; key?: string },
  {
    fetchFn = fetch,
    errorReason,
  }: { fetchFn?: typeof fetch; errorReason?: OpenRouterErrorReason } = {},
): Promise<{ id: string; reasoningLevels: string[]; answered: boolean }> {
  let response: Response;
  try {
    response = await fetchFn(`${CATALOG.openrouter.base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Call the ping tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "ping",
              description: "health check",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 32,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ModelValidationError(
      "catalog_unavailable",
      "OpenRouter request failed",
      {
        cause,
      },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ModelValidationError(
      "auth_rejected",
      `OpenRouter rejected credentials (${response.status})`,
      {
        status: response.status,
      },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ModelValidationError(
      "catalog_invalid",
      "OpenRouter returned invalid JSON",
      {
        status: response.status,
        cause,
      },
    );
  }
  if (!response.ok) {
    const detail =
      errorReason?.(body, response.status) ??
      (isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
        ? body.error.message
        : "");
    // Preserve the former template-literal coercion for malformed provider
    // values while keeping the callback contract honest at its boundary.
    const reason = detail ? `: ${detail as string}` : "";
    throw new ModelValidationError(
      "model_unavailable",
      `OpenRouter rejected model ${model}${reason}`,
      { status: response.status },
    );
  }
  const choices =
    isRecord(body) && Array.isArray(body.choices)
      ? (body.choices as unknown[])
      : [];
  const first = choices[0];
  const message = isRecord(first) ? first.message : undefined;
  const answered = Boolean(
    (isRecord(message) &&
      typeof message.content === "string" &&
      message.content.trim()) ||
    (isRecord(message) &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length),
  );
  // A reasoning model can spend the entire small probe allowance before it
  // emits visible content. HTTP 200 still proves that the key, slug and tools
  // request were accepted, matching setup's long-standing probe contract.
  return { id: model, reasoningLevels: [], answered };
}

export async function validateModelSelection(
  { provider, model, key, dataDir }: ModelSelection,
  { fetchFn = fetch, listCodexCatalog }: ValidationOptions = {},
): Promise<{ id: string; reasoningLevels: string[]; answered?: boolean }> {
  if (
    typeof provider !== "string" ||
    !Object.hasOwn(CATALOG, provider) ||
    typeof model !== "string" ||
    !model.trim() ||
    /[\r\n]/.test(model)
  ) {
    throw new ModelValidationError(
      "invalid_selection",
      "invalid provider or model selection",
    );
  }
  const selected = model.trim();
  if (provider === "openrouter") {
    return probeOpenRouterModel({ model: selected, key }, { fetchFn });
  }
  try {
    const options = await fetchModelOptions(provider, key, {
      dataDir,
      fetchFn,
      ...(listCodexCatalog ? { listCodexCatalog } : {}),
    });
    const match = options.find((option) => option.id === selected);
    if (!match) {
      throw new ModelValidationError(
        "model_unavailable",
        `${selected} is not present in the live ${CATALOG[provider].label} catalog`,
      );
    }
    return match;
  } catch (error) {
    throw validationError(error);
  }
}
