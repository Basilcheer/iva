/** Return a trimmed IANA timezone accepted by `Intl`, or `null`. */
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

/** Resolve every configured timezone to a valid IANA zone or the stable UTC fallback. */
export function resolveTimeZone(value: unknown): string {
  return validateTimeZone(value) ?? "UTC";
}
