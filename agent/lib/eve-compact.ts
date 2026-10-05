/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- conversion keeps the injectable fetch boundary source-compatible. */
// Просьба к eve пересказать историю сессии — штатный роут eve-канала
// POST /eve/v1/session/:sessionId/compact под общим токеном внутренних клиентов Ивы
// (agent/lib/eve-auth.ts). Событийные обработчики канала публичный compact() не получают,
// поэтому канал зовёт роут собственного процесса.
import { localChannelUrl } from "./telegram-cancel-route.ts";

/** Адрес роута свёртки сессии по правилу хоста собственных роутов канала. */
export const localSessionCompactUrl = (
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  localChannelUrl(
    `/eve/v1/session/${encodeURIComponent(sessionId)}/compact`,
    env,
  );

type FetchResponse = {
  status: number;
  json: () => Promise<unknown>;
};
type FetchImpl = (url: string, init: RequestInit) => Promise<FetchResponse>;

/**
 * true — eve приняла просьбу (202 accepted) и поставит пересказ за активным ходом.
 * false — eve ответила отказом: сессии уже нет, токен не подошёл, сбой диспетчера.
 * Исключение — ответа нет (таймаут, обрыв): приняла ли eve просьбу, неизвестно.
 */
export async function requestSessionCompact({
  url,
  bearer,
  fetchImpl = fetch as unknown as FetchImpl,
  timeoutMs = 5_000,
  logImpl = console.error,
}: {
  url: string;
  bearer: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  logImpl?: (...parts: unknown[]) => void;
}): Promise<boolean> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: { status?: unknown } | null = null;
  try {
    body = (await response.json()) as { status?: unknown } | null;
  } catch {
    /* не-JSON ответ — отказ с его HTTP-статусом */
  }
  if (response.status === 202 && body?.status === "accepted") return true;
  if (!(response.status === 200 && body?.status === "no_active_session"))
    logImpl(
      `[telegram] eve отклонила свёртку сессии: HTTP ${String(response.status)}`,
    );
  return false;
}
