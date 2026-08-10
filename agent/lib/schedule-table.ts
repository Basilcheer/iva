// Single source of truth for the Schedules Iva runs in-process (agent/schedules/*.ts):
// schedule name → cron expression. Names are the status-file keys too — the same string
// each schedule passes to runScheduledJob (scripts/lib/schedule-runner.ts).
//
// Three consumers read this table instead of keeping hand-synced copies: the schedule
// files themselves, scripts/lib/schedule-migration.ts (catch-up math for a missed run)
// and scripts/lib/menu/crons.ts (the /menu → ⏰ display, which shows the entries in the
// order they are declared here). A cadence change is one edit here.
//
// Crons fire in the PROCESS's local time — agent/instrumentation.ts sets TZ from
// ASSISTANT_TIMEZONE at startup — so "0 4 * * *" means 04:00 local.
export const SCHEDULE_CRON = {
  "memory-daily": "0 4 * * *",
  "memory-weekly": "15 4 * * 1",
  "memory-monthly": "20 4 1 * *",
  "memory-yearly": "25 4 1 1 *",
  digest: "0 8 * * *",
} as const;

export type ScheduleName = keyof typeof SCHEDULE_CRON;

// The wall-clock point a schedule fires at, for the consumer that needs the time itself
// rather than the cron string. Every entry above fires at a fixed minute of a fixed hour,
// so the first two cron fields are the whole answer.
export function scheduleTimeOfDay(name: ScheduleName): {
  readonly hour: number;
  readonly minute: number;
} {
  const [minute, hour] = SCHEDULE_CRON[name].split(" ");
  return { hour: Number(hour), minute: Number(minute) };
}
