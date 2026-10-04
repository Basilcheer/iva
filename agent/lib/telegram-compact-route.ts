/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- conversion keeps the injectable fetch boundary source-compatible. */
import { verifyTelegramRequest } from "eve/channels/telegram";
import type { AttachSessionFn } from "eve/channels";
import { localChannelUrl } from "./telegram-cancel-route.ts";

export const TELEGRAM_COMPACT_ROUTE = "/eve/v1/telegram/compact";

/** Собственный адрес compact-роута: канал зовёт его сам после законченного хода. */
export const localCompactUrl = (env: NodeJS.ProcessEnv = process.env) =>
  localChannelUrl(TELEGRAM_COMPACT_ROUTE, env);

/**
 * Свёртка истории сессии по её точному sessionId. Живёт в роуте по той же причине, что и
 * отмена хода: публичный compact eve отдаётся только через RouteHandlerArgs, событийные
 * обработчики канала его не получают. Секрет — тот же, что у cancel и reset.
 *
 * eve ставит просьбу в очередь за активным ходом, сообщения пользователя не добавляет и
 * при сбое пересказа оставляет историю как была.
 */
export async function handleTelegramCompactRequest(
  req: Request,
  attachSession: AttachSessionFn,
  secretToken?: string,
): Promise<Response> {
  let raw;
  try {
    raw = await verifyTelegramRequest(req, { secretToken });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(raw) as { sessionId?: unknown } | null;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return new Response("sessionId is required", { status: 400 });
  }

  const result = await attachSession(sessionId).compact();
  return Response.json({ ok: true, status: result.status });
}

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
type FetchImpl = (url: string, init: RequestInit) => Promise<FetchResponse>;

/** Зовёт compact-роут канала. true — eve приняла просьбу; false — сессии уже нет. */
export async function requestTelegramCompact({
  url,
  secret,
  sessionId,
  fetchImpl = fetch as unknown as FetchImpl,
  timeoutMs = 5_000,
}: {
  url: string;
  secret: string;
  sessionId: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}): Promise<boolean> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`Eve compact route returned HTTP ${response.status}`);

  const body = (await response.json()) as { ok?: unknown; status?: unknown };
  if (
    body?.ok !== true ||
    (body.status !== "accepted" && body.status !== "no_active_session")
  ) {
    throw new Error("Eve compact route returned an invalid response");
  }
  return body.status === "accepted";
}
