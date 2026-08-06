type SetupValues = Record<string, unknown>;

export function keptSetupWritePlan(existing: SetupValues, next: SetupValues) {
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  for (const key of keys) {
    if (!Object.is(existing[key], next[key])) return "validate-and-write";
  }
  return "skip";
}
