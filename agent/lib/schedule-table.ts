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

// The cron fields, for the consumer that has to place a fire time on the calendar itself
// rather than hand the string to a cron engine. `null` is cron's `*` — that field puts no
// constraint on the date. Day-of-week is normalized to JS's 0=Sunday..6=Saturday.
export interface ScheduleCron {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number | null;
  readonly month: number | null;
  readonly dayOfWeek: number | null;
}

// A single field: a plain number, or null for `*`. Every entry above is deliberately that
// simple; a list, range or step would parse as NaN and silently move a fire time, so it is
// refused here instead.
function cronField(value: string): number | null {
  if (value === "*") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new TypeError(`unsupported cron field "${value}"`);
  return parsed;
}

export function scheduleCron(name: ScheduleName): ScheduleCron {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = SCHEDULE_CRON[name]
    .split(" ")
    .map(cronField);
  if (minute === null || hour === null)
    throw new TypeError(`${name} must fire at a fixed minute of a fixed hour`);
  // Real cron ORs day-of-month with day-of-week when both are constrained. No entry above
  // does, and a consumer would have to guess which rule wins — so refuse that shape too.
  if (dayOfMonth !== null && dayOfWeek !== null)
    throw new TypeError(
      `${name} must not constrain both day-of-month and day-of-week`,
    );
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    // cron writes Sunday as 0 or 7; JS Date.getUTCDay() only says 0.
    dayOfWeek: dayOfWeek === null ? null : dayOfWeek % 7,
  };
}
