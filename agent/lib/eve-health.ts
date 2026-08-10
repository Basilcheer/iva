// Ожидание собственного HTTP-слушателя eve: опрос локального /eve/v1/health до 200 или
// дедлайна. Живёт в authored tree, потому что первым его зовёт agent/instrumentation.ts —
// катч-ап расписаний нельзя запускать, пока слушатель не принимает соединения. `iva config`
// спрашивает то же самое после рестарта сервиса и берёт эту функцию ленивым импортом
// (scripts/lib/config-transaction.ts): проверка здоровья на дереве, которое не стартует,
// одинаково кончается откатом.
export interface ProbeEveHealthOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Флаг старта-пробы апдейтера: этот запуск сервера — проверка кандидата, а не рабочий. */
export const PROBE_FLAG = "IVA_HEALTH_PROBE";

export async function probeEveHealth(
  url: string,
  {
    fetchFn = fetch,
    timeoutMs = 15_000,
    intervalMs = 250,
    now = Date.now,
    sleep,
  }: ProbeEveHealthOptions = {},
): Promise<void> {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
    parsed.pathname !== "/eve/v1/health"
  ) {
    throw new Error("health check must use the local /eve/v1/health route");
  }
  const wait =
    sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let lastStatus = null;
  do {
    try {
      const remaining = Math.max(1, deadline - now());
      const response = await fetchFn(parsed, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(2_000, remaining)),
      });
      lastStatus = response.status;
      if (response.ok) return;
    } catch {
      // Connection failures are retried until the health-check deadline.
    }
    if (now() < deadline)
      await wait(Math.min(intervalMs, Math.max(1, deadline - now())));
  } while (now() < deadline);
  throw Object.assign(
    new Error(
      lastStatus === null
        ? "local Eve health check timed out"
        : `local Eve health returned ${lastStatus}`,
    ),
    { code: "EHEALTH" },
  );
}
