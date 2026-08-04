// Типы для settings.mjs (чистый ESM) — чтобы tsgo-потребитель agent/schedules/digest.ts
// не ловил TS7016. Тот же паттерн, что run-status.d.mts / i18n.d.mts рядом.
export function readSettings(): Record<string, unknown>;
export function writeSettings(patch: Record<string, unknown>): Record<string, unknown>;
