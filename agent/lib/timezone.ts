// Проверка имени IANA-зоны для authored tree: agent/instrumentation.ts подставляет
// ASSISTANT_TIMEZONE в process.env.TZ, а неизвестная зона роняет RangeError'ом каждого
// потребителя Intl. Предикат самодостаточный и повторён в scripts/lib/timezone.ts —
// тот же вопрос задаёт `iva doctor`, когда пишет systemd-юниты на инсталле, где каталога
// agent/ может не быть вовсе. Две копии сверяет одной таблицей scripts/lib/timezone.test.ts.
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
