export function keptSetupWritePlan(existing, next) {
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  for (const key of keys) {
    if (!Object.is(existing[key], next[key])) return "validate-and-write";
  }
  return "skip";
}
