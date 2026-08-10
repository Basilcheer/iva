// The eight retired iva-memory-{daily,weekly,monthly,yearly}.{service,timer} units, as the
// CLI sees them. `iva doctor`/`iva update` sweep them from every install on the way to the
// in-process eve schedules, and writeUnits() is synchronous on a tree whose agent/ may be
// missing or half-written — so the list cannot be reached for in the authored tree, where
// agent/lib/schedule-migration.ts retires the same eight from the server side. The set is
// historical and frozen; the two copies are pinned in agent/lib/schedule-migration.test.ts.
export const LEGACY_MEMORY_UNITS: readonly string[] = [
  "iva-memory-daily.service",
  "iva-memory-daily.timer",
  "iva-memory-weekly.service",
  "iva-memory-weekly.timer",
  "iva-memory-monthly.service",
  "iva-memory-monthly.timer",
  "iva-memory-yearly.service",
  "iva-memory-yearly.timer",
];
