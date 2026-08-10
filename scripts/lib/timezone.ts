// Копия предиката из agent/lib/timezone.ts для дерева scripts/: `iva doctor` пишет
// systemd-юниты (и подставляет TZ) на инсталле, где каталога agent/ может не быть, а
// writeUnits синхронный — ленивый импорт сюда не годится. Обе копии сверяет одной
// таблицей scripts/lib/timezone.test.ts.
export function validateTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch (error: unknown) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
