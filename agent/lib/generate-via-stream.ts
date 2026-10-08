import type { LanguageModelMiddleware } from "ai";

// Вызов модели без стрима, выполненный стримом. Нужен провайдеру, чей бэкенд принимает только
// stream:true (подписка ChatGPT, codex): generateText идёт через doGenerate, и такой бэкенд
// отвечает 400. Сборка повторяет то, как streamText из ai складывает content: дельты одного id
// склеиваются в одну часть, providerMetadata — последнее непустое значение.
// Типы берём из middleware, чтобы не тянуть @ai-sdk/provider.
type WrapGenerateOptions = Parameters<
  NonNullable<LanguageModelMiddleware["wrapGenerate"]>
>[0];
type GenerateResult = Awaited<ReturnType<WrapGenerateOptions["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<WrapGenerateOptions["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type Content = GenerateResult["content"][number];
type TextLike = Extract<Content, { type: "text" | "reasoning" }>;
type PartOf<T extends StreamPart["type"]> = Extract<StreamPart, { type: T }>;
type TextLikePart = PartOf<
  | "text-start"
  | "text-delta"
  | "text-end"
  | "reasoning-start"
  | "reasoning-delta"
  | "reasoning-end"
>;

/** Что уже собрано из потока. */
interface Assembly {
  readonly content: Content[];
  /** Начатые и ещё не закрытые text/reasoning по ключу `<вид>:<id>`. */
  readonly open: Map<string, TextLike>;
  warnings: GenerateResult["warnings"];
  metadata: Omit<PartOf<"response-metadata">, "type">;
  finish?: PartOf<"finish">;
}

/** Ошибка из потока как исключение: Error как есть, объект провайдера — текстом с телом. */
function streamError(error: unknown): Error {
  if (error instanceof Error) return error;
  const body = typeof error === "string" ? error : JSON.stringify(error);
  return new Error(`model stream failed: ${body}`, { cause: error });
}

function textLike(assembly: Assembly, part: TextLikePart): void {
  const kind = part.type.startsWith("text") ? "text" : "reasoning";
  const key = `${kind}:${part.id}`;
  if (part.type.endsWith("-start")) {
    const started: TextLike = { type: kind, text: "" };
    if (part.providerMetadata) started.providerMetadata = part.providerMetadata;
    assembly.open.set(key, started);
    assembly.content.push(started);
    return;
  }
  const active = assembly.open.get(key);
  if (!active) throw new Error(`${kind} part ${part.id} not found`);
  if ("delta" in part) active.text += part.delta;
  if (part.providerMetadata) active.providerMetadata = part.providerMetadata;
  if (part.type.endsWith("-end")) assembly.open.delete(key);
}

const ignore = (): void => {};

// Вход инструмента целиком приходит частью tool-call, поэтому tool-input-* не собираются.
const HANDLERS: {
  [T in StreamPart["type"]]?: (assembly: Assembly, part: PartOf<T>) => void;
} = {
  "stream-start": (assembly, part) => {
    assembly.warnings = part.warnings;
  },
  "response-metadata": (assembly, { id, timestamp, modelId }) => {
    assembly.metadata = { id, timestamp, modelId };
  },
  "text-start": textLike,
  "text-delta": textLike,
  "text-end": textLike,
  "reasoning-start": textLike,
  "reasoning-delta": textLike,
  "reasoning-end": textLike,
  "tool-input-start": ignore,
  "tool-input-delta": ignore,
  "tool-input-end": ignore,
  raw: ignore,
  error: (_assembly, part) => {
    throw streamError(part.error);
  },
  finish: (assembly, part) => {
    assembly.finish = part;
  },
};

function absorb(assembly: Assembly, part: StreamPart): void {
  const handler = HANDLERS[part.type] as
    ((assembly: Assembly, part: StreamPart) => void) | undefined;
  if (handler) handler(assembly, part);
  else assembly.content.push(part as Content);
}

/** Читает поток до конца; abortSignal отменяет чтение и закрывает поток. */
async function readAll(
  stream: ReadableStream<StreamPart>,
  assembly: Assembly,
  abortSignal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const cancel = () => void reader.cancel(abortSignal?.reason).catch(ignore);
  abortSignal?.addEventListener("abort", cancel, { once: true });
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      abortSignal?.throwIfAborted();
      if (next.done) break;
      absorb(assembly, next.value);
    }
    done = true;
  } finally {
    abortSignal?.removeEventListener("abort", cancel);
    if (!done) await reader.cancel().catch(ignore);
  }
}

// Провайдер дописывает finish и в пустой поток (@ai-sdk/openai шлёт его в flush даже без
// response.completed), поэтому признак ответа — содержимое: непустой текст или вызов
// инструмента. Пустой «ответ» не становится итогом: пересказ eve заменил бы им историю.
function hasAnswer(content: readonly Content[]): boolean {
  return content.some(
    (part) =>
      part.type === "tool-call" ||
      (part.type === "text" && part.text.trim() !== ""),
  );
}

function noAnswerError(result: GenerateResult): Error {
  const reasoning = result.content.some((part) => part.type === "reasoning");
  return new Error(
    `model stream ended without an answer: finish ${result.finishReason.unified}, ${String(result.content.length)} parts, reasoning ${reasoning ? "yes" : "no"}`,
    { cause: result },
  );
}

/**
 * Читает поток doStream до конца и отдаёт результат по контракту doGenerate. Ошибка в потоке,
 * обрыв (нет finish или текст не закрыт), ответ без текста и без вызова инструмента и
 * abortSignal — исключение: частичный или пустой текст итогом не становится.
 */
export async function generateViaStream(
  doStream: WrapGenerateOptions["doStream"],
  abortSignal?: AbortSignal,
): Promise<GenerateResult> {
  abortSignal?.throwIfAborted();
  const { stream, request, response } = await doStream();
  const assembly: Assembly = {
    content: [],
    open: new Map(),
    warnings: [],
    metadata: {},
  };
  await readAll(stream, assembly, abortSignal);
  const { finish } = assembly;
  if (!finish || assembly.open.size > 0)
    throw new Error("model stream ended before the answer was finished");
  const result: GenerateResult = {
    content: assembly.content,
    finishReason: finish.finishReason,
    usage: finish.usage,
    ...(finish.providerMetadata
      ? { providerMetadata: finish.providerMetadata }
      : {}),
    request,
    response: { ...assembly.metadata, headers: response?.headers },
    warnings: assembly.warnings,
  };
  if (!hasAnswer(result.content)) throw noAnswerError(result);
  return result;
}
