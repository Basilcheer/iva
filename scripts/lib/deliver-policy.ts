// Политика ретраев доставки апдейта в eve. Мост однопоточный: пока deliver() ретраит,
// polling стоит, но durable inbox/queue head остаётся владельцем payload:
//
// - retry: лечится временем — сеть, 5xx и «повтори позже» (408/425/429). Быстрый бэкофф.
// - config: 401/403/404 — это не битый апдейт, а сломанная КОНФИГУРАЦИЯ (secret/route
//   разъехались): выбрасывать сообщения нельзя — терялись бы пачками до починки. Ретраим
//   вечно с ДЛИННЫМ бэкоффом + громко зовём владельца.
// - bounded: остальные 4xx (400/413/422…) ограничивают один delivery pass; durable
//   ownership остаётся у caller, поэтому результат нельзя считать terminal ack.
const RETRYABLE_4XX = new Set([408, 425, 429]);
const CONFIG_4XX = new Set([401, 403, 404]);

export type DeliverClassification = "retry" | "config" | "bounded";

export function classifyDeliverStatus(
  status: number,
  { acceptance = false }: { acceptance?: boolean } = {},
): DeliverClassification {
  // The authored acceptance route reserves 503 for a completed webhook dispatch
  // which did not reach Eve send(). Retrying may still bridge a short startup race,
  // but it must use the bounded-pass policy rather than pinning the polling loop
  // forever like an ordinary transient 5xx.
  if (acceptance && status === 503) return "bounded";
  if (status >= 500 || RETRYABLE_4XX.has(status)) return "retry";
  if (CONFIG_4XX.has(status)) return "config";
  return "bounded";
}
