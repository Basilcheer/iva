// Single source of truth for the Schedules Iva runs in-process (agent/schedules/*.ts):
// schedule name → cron expression. Names are the status-file keys too — the same string
// each schedule passes to runScheduledJob (scripts/lib/schedule-runner.ts).
//
// Three consumers read this table instead of keeping hand-synced copies: the schedule
// files themselves, agent/lib/schedule-migration.ts (catch-up math for a missed run)
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

// The five fields a cron line carries, in order, with the values each one accepts.
const FIELDS = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day-of-month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12 },
  { label: "day-of-week", min: 0, max: 7 }, // 7 is Sunday again, normalized below
] as const;

// A single field: a plain number in range, or null for `*`. Every entry above is
// deliberately that simple. Anything else — a list, range or step, an empty field left by
// a stray double space, a value cron itself would reject — would silently move a fire
// time, so it is refused here rather than parsed into an approximation.
function cronField(
  value: string,
  field: (typeof FIELDS)[number],
): number | null {
  if (value === "*") return null;
  if (!/^\d{1,2}$/.test(value))
    throw new TypeError(`unsupported ${field.label} field "${value}"`);
  const parsed = Number(value);
  if (parsed < field.min || parsed > field.max)
    throw new TypeError(
      `${field.label} "${value}" is outside ${field.min}..${field.max}`,
    );
  return parsed;
}

// Parses a table entry into calendar fields. Every throw below marks a shape no consumer
// can place on a calendar; the table's own test calls this for each entry, so a bad edit
// fails at desk time instead of drifting the catch-up point in production.
export function parseCron(cron: string): ScheduleCron {
  const fields = cron.split(" ");
  // Field count first: a 6-field cron (the seconds-first dialect croner also accepts) and
  // a 4-field one both parse field-by-field without complaint, each one silently reading
  // an hour as a minute, a day as an hour, and so on.
  if (fields.length !== FIELDS.length)
    throw new TypeError(
      `cron "${cron}" must have ${FIELDS.length} fields (minute hour day-of-month month day-of-week), not ${fields.length}`,
    );
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map(
    (value, index) => cronField(value, FIELDS[index]),
  );
  if (minute === null || hour === null)
    throw new TypeError(`cron "${cron}" must fire at a fixed minute and hour`);
  // Real cron ORs day-of-month with day-of-week when both are constrained. No entry above
  // does, and a consumer would have to guess which rule wins — so refuse that shape too.
  if (dayOfMonth !== null && dayOfWeek !== null)
    throw new TypeError(
      `cron "${cron}" must not constrain both day-of-month and day-of-week`,
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
