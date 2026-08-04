export function validateTimeZone(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
