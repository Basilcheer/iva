import type { CancelFn, CancelTurnResult } from "eve/channels";

/**
 * Единственное место КАНАЛЬНОЙ отмены: отмены хода, пришедшей снаружи по
 * continuation-токену (кнопка ⏹ Стоп и /stop). При миграции на eve 0.31+ править
 * здесь: continuation-token API там снят, а отмена переехала на session-handles
 * (`attachSession`). Маршрут, статус хода и кнопка про способ отмены не знают.
 *
 * `cancel` приходит из RouteHandlerArgs, поэтому вызывающий обязан быть роутом
 * канала: событийные обработчики этот helper не получают.
 *
 * Второй, НЕ канальный путь отмены в проекте — `scripts/lib/rollup-turn.ts`
 * (`cancelTurnQuietly` / `cancelTurnAndConfirmQuietly`): ночной роллап держит
 * client-сессию eve и гасит свой зависший ход через `session.cancel()`. Это другой
 * API и другой владелец сессии, сюда он не сводится; при апгрейде eve его надо
 * мигрировать отдельно.
 */
export interface EveCancelRequest {
  /** Channel-local raw token, в том же виде, в каком его принимает send/reset. */
  readonly continuationToken: string;
  /** Гард от опоздавшего нажатия: несовпавший turnId eve глотает как no-op. */
  readonly turnId?: string;
}

/** Оба статуса — успех: `accepted` и `no_active_turn` (отменять уже нечего). */
export function cancelEveTurn(
  cancel: CancelFn,
  { continuationToken, turnId }: EveCancelRequest,
): Promise<CancelTurnResult> {
  return cancel({
    continuationToken,
    ...(turnId === undefined ? {} : { turnId }),
  });
}
