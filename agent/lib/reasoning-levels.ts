// Стабильный словарь reasoning-усилий, который понимает рантайм: agent/provider.ts сверяет
// с ним THINKING_EFFORT перед тем, как отдать его провайдеру. `ultra` намеренно не
// поддерживается. Тот же список повторён в scripts/lib/reasoning-levels.ts — кнопки /think и
// проверка модели в `iva config` грузятся на инсталле, где каталога agent/ может не быть.
// Разъехаться копии не могут: их сверяет scripts/lib/reasoning-levels.test.ts.
export const CANONICAL_REASONING_EFFORTS = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
