// One-shot, idempotent migration from the old systemd memory-rollup timers to the
// in-process eve schedules (agent/schedules/memory-*.ts). Called fire-and-forget from
// agent/instrumentation.ts on every server start. Two INDEPENDENT jobs — independent
// enough that only one of them needs systemd at all:
//
//   1. tear down the 8 retired iva-memory-{daily,weekly,monthly,yearly}.{service,timer}
//      units, by exact name only — self-host users may have their own unrelated timers
//      (e.g. xfeed-daily.timer) sitting in the same directory, never touch those. Skipped
//      entirely wherever there is no user systemd at all (containers, this repo's own
//      `npm run replica` sandbox, CI) — there is nothing to tear down there.
//   2. catch up a period whose last systemd-timer success predates its most recent
//      scheduled point, bounded by a grace window so a months-old miss doesn't fire late.
//      Persistent=true is gone with the timers, so this replaces it — and runs on every
//      boot REGARDLESS of systemd availability, since a missed rollup is worth catching
//      up whether or not this host ever had systemd units to retire in the first place.
//
// Must NEVER throw: a broken systemctl or a corrupt status file must not stop the server
// from starting.
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  readStatus,
  runScheduledJob,
  withStatusLock,
  writeStatusAtomic,
} from "#lib/schedule-runner.ts";

type Period = "daily" | "weekly" | "monthly" | "yearly";

interface ExecResult {
  readonly code: number;
  readonly out?: string;
  readonly err?: string;
  readonly error?: unknown;
}

type ExecImplementation = (args: readonly string[]) => ExecResult;

interface MigrationStatusEntry {
  readonly lastSuccessAt?: number;
  readonly seededAt?: number;
  readonly [key: string]: unknown;
}

type MigrationStatus = Record<string, MigrationStatusEntry>;

interface DuePeriod {
  readonly period: Period;
  readonly dueAt: number;
  readonly effectiveBaseline: number | undefined;
}

type MigrationDecision =
  | { readonly action: "defer" }
  | {
      readonly action: "run";
      readonly due: readonly DuePeriod[];
      readonly freshlySeeded: readonly Period[];
    };

export interface RunScheduleMigrationOptions {
  readonly homedir?: string;
  readonly execImpl?: ExecImplementation;
  readonly statusPath?: string;
  readonly tz?: string;
  readonly log?: (...args: unknown[]) => void;
  readonly now?: () => number;
  readonly root?: string;
  readonly nodeBin?: string;
  readonly runJob?: (period: Period) => Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return (error as { readonly message: string }).message;
}

function errorCode(error: unknown): unknown {
  return (error as { readonly code?: unknown } | null | undefined)?.code;
}

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

// { period, cron hour:minute in local tz, day-of-week|day-of-month|month constraint }
// mirrors the cron strings the eve schedules carry (see agent/schedules/memory-*.ts) —
// keep these two in sync by hand, there is no single shared source at the cron-string level.
const PERIOD_SCHEDULE: Record<
  Period,
  { readonly hour: number; readonly minute: number; readonly graceMs: number }
> = {
  daily: { hour: 4, minute: 0, graceMs: 20 * 60 * 60 * 1000 },
  weekly: { hour: 4, minute: 15, graceMs: 3 * 24 * 60 * 60 * 1000 },
  monthly: { hour: 4, minute: 20, graceMs: 7 * 24 * 60 * 60 * 1000 },
  yearly: { hour: 4, minute: 25, graceMs: 14 * 24 * 60 * 60 * 1000 },
};
const PERIODS = Object.keys(PERIOD_SCHEDULE) as Period[];

// The status-file key a real run is recorded under — must match the `name` each
// agent/schedules/memory-*.ts passes to runScheduledJob, not the bare period.
function statusKey(period: Period): string {
  return `memory-${period}`;
}

function defaultExecImpl(args: readonly string[]): ExecResult {
  const r = spawnSync("systemctl", args, { encoding: "utf8" });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
    error: r.error,
  };
}

// ── timezone-aware "most recent due point" math ─────────────────────────────
// No Temporal/date library dependency: derive local wall-clock Y-M-D-H-M from Intl, then
// convert a candidate local wall-clock point back to a UTC epoch by the standard
// guess-and-correct trick (good to the minute, which is all a memory rollup needs).
function zonedParts(
  epochMs: number,
  tz: string,
): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]),
  );
  // Midnight sometimes formats as "24" in en-US hour12:false — normalize to 0.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: hour,
    mm: Number(parts.minute),
    ss: Number(parts.second),
  };
}

function zonedToUtcMs(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): number {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const seen = zonedParts(guess, tz);
    const seenAsUtc = Date.UTC(
      seen.y,
      seen.m - 1,
      seen.d,
      seen.hh,
      seen.mm,
      seen.ss,
    );
    const wantAsUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
    const diff = seenAsUtc - wantAsUtc;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

function addDaysToDate(
  y: number,
  m: number,
  d: number,
  days: number,
): { y: number; m: number; d: number } {
  const shifted = new Date(Date.UTC(y, m - 1, d, 12) + days * 86_400_000); // noon avoids DST edge cases
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

function prevMonth(y: number, m: number): { y: number; m: number } {
  return m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
}

// Monday=0 .. Sunday=6, from a plain Y-M-D calendar date (weekday does not depend on tz
// once the calendar date itself is fixed).
function mondayOffset(y: number, m: number, d: number): number {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return (dow + 6) % 7;
}

// Returns the most recent scheduled UTC epoch ms for a period, at or before `nowMs`.
function lastDueMs(period: Period, nowMs: number, tz: string): number {
  const { hour, minute } = PERIOD_SCHEDULE[period];
  const today = zonedParts(nowMs, tz);

  if (period === "daily") {
    const candidate = zonedToUtcMs(today.y, today.m, today.d, hour, minute, tz);
    if (candidate <= nowMs) return candidate;
    const y = addDaysToDate(today.y, today.m, today.d, -1);
    return zonedToUtcMs(y.y, y.m, y.d, hour, minute, tz);
  }
  if (period === "weekly") {
    const back = mondayOffset(today.y, today.m, today.d);
    const monday = addDaysToDate(today.y, today.m, today.d, -back);
    const candidate = zonedToUtcMs(
      monday.y,
      monday.m,
      monday.d,
      hour,
      minute,
      tz,
    );
    if (candidate <= nowMs) return candidate;
    const prevMonday = addDaysToDate(monday.y, monday.m, monday.d, -7);
    return zonedToUtcMs(
      prevMonday.y,
      prevMonday.m,
      prevMonday.d,
      hour,
      minute,
      tz,
    );
  }
  if (period === "monthly") {
    const candidate = zonedToUtcMs(today.y, today.m, 1, hour, minute, tz);
    if (candidate <= nowMs) return candidate;
    const prev = prevMonth(today.y, today.m);
    return zonedToUtcMs(prev.y, prev.m, 1, hour, minute, tz);
  }
  // yearly
  const candidate = zonedToUtcMs(today.y, 1, 1, hour, minute, tz);
  if (candidate <= nowMs) return candidate;
  return zonedToUtcMs(today.y - 1, 1, 1, hour, minute, tz);
}

// ── legacy unit teardown ─────────────────────────────────────────────────
function removeLegacyUnits({
  homedir,
  execImpl,
  log,
}: Required<
  Pick<RunScheduleMigrationOptions, "homedir" | "execImpl" | "log">
>): void {
  const unitDir = join(homedir, ".config/systemd/user");
  let touchedAny = false;
  for (const unit of LEGACY_MEMORY_UNITS) {
    const path = join(unitDir, unit);
    if (!existsSync(path)) continue;
    touchedAny = true;
    let disabled = false;
    try {
      const result = execImpl(["--user", "disable", "--now", unit]);
      if (result.code !== 0) {
        log(
          `schedule-migration: disable --now ${unit} failed (best-effort): ${result.err || result.out}`,
        );
      } else {
        disabled = true;
      }
    } catch (error) {
      log(
        `schedule-migration: disable --now ${unit} threw (best-effort): ${errorMessage(error)}`,
      );
    }
    // Only remove the file once systemd has actually let go of the unit. Deleting it
    // after a failed disable would leave a still-enabled/active unit with no file behind
    // — invisible to a human, but still running (or still armed to run again). Leaving
    // the file in place means this boot's cleanup is simply retried on the next one,
    // same as a partial systemctl failure anywhere else in this function.
    if (!disabled) {
      log(
        `schedule-migration: leaving ${unit} in place — disable failed, the next boot will retry`,
      );
      continue;
    }
    try {
      rmSync(path, { force: true });
    } catch (error) {
      log(
        `schedule-migration: removing ${unit} failed (best-effort): ${errorMessage(error)}`,
      );
    }
  }
  if (touchedAny) {
    try {
      const reload = execImpl(["--user", "daemon-reload"]);
      if (reload.code !== 0)
        log(
          `schedule-migration: daemon-reload failed (best-effort): ${reload.err || reload.out}`,
        );
    } catch (error) {
      log(
        `schedule-migration: daemon-reload threw (best-effort): ${errorMessage(error)}`,
      );
    }
    try {
      const reset = execImpl(["--user", "reset-failed"]);
      if (reset.code !== 0)
        log(
          `schedule-migration: reset-failed failed (best-effort): ${reset.err || reset.out}`,
        );
    } catch (error) {
      log(
        `schedule-migration: reset-failed threw (best-effort): ${errorMessage(error)}`,
      );
    }
  }
}

export async function runScheduleMigration({
  homedir,
  execImpl = defaultExecImpl,
  statusPath,
  tz = "UTC",
  log = () => {},
  now = () => Date.now(),
  root,
  nodeBin = process.execPath,
  runJob,
}: RunScheduleMigrationOptions = {}): Promise<void> {
  try {
    if (!statusPath) return;

    const runPeriod =
      runJob ??
      ((period: Period) =>
        runScheduledJob({
          name: `memory-${period}`,
          argv: ["scripts/memory/rollup.ts", period],
          root,
          nodeBin,
          lockPath: root ? join(root, ".memory.lock") : undefined,
          statusPath,
          log,
        }));

    // Per-key seed, the seed write, AND the due-check all happen inside the
    // SAME single lock acquisition runScheduledJob's own admission check uses — never
    // decided from a status snapshot read outside any critical section. Two things this
    // closes: (1) a real run's own read-modify-write (recording inProgressSince/
    // lastStartedAt) racing the seed write and one silently clobbering the other; (2) the
    // due-or-not decision for each period being made from a stale snapshot that could
    // already be out of date by the time it's used. If the lock can't be acquired at
    // all, this whole pass is deferred rather than deciding anything from an unlocked
    // read — the next boot (or, for a period a Nitro tick fires in the meantime, that
    // tick itself) retries cleanly.
    const decision = await withStatusLock<MigrationDecision>(
      statusPath,
      (acquired) => {
        if (!acquired) {
          log(
            "schedule-migration: could not acquire the status lock in time — deferring this pass (retried on the next boot)",
          );
          return { action: "defer" };
        }
        const current: MigrationStatus = readStatus(statusPath);
        const nowMs = now();
        const seeded: MigrationStatus = { ...current };
        const freshlySeeded = new Set<Period>();
        for (const period of PERIODS) {
          const key = statusKey(period);
          const entry = current[key];
          if (
            typeof entry?.lastSuccessAt !== "number" &&
            typeof entry?.seededAt !== "number"
          ) {
            seeded[key] = { ...entry, seededAt: nowMs };
            freshlySeeded.add(period);
          }
        }
        if (freshlySeeded.size > 0) writeStatusAtomic(statusPath, seeded);

        const due: DuePeriod[] = [];
        for (const period of PERIODS) {
          if (freshlySeeded.has(period)) continue;
          const { graceMs } = PERIOD_SCHEDULE[period];
          const dueAt = lastDueMs(period, nowMs, tz);
          const entry = seeded[statusKey(period)];
          // A real success always wins; otherwise fall back to the seeded baseline (if
          // any) so a freshly-seeded period doesn't immediately look "due" the moment
          // it's due relative to real time — same suppression the old
          // lastSuccessAt-as-seed did.
          const recorded =
            typeof entry?.lastSuccessAt === "number"
              ? entry.lastSuccessAt
              : entry?.seededAt;
          const effectiveBaseline = recorded;
          const alreadyCaughtUp =
            effectiveBaseline !== undefined && effectiveBaseline >= dueAt;
          const withinGrace = nowMs - dueAt <= graceMs;
          if (!alreadyCaughtUp && withinGrace)
            due.push({ period, dueAt, effectiveBaseline });
        }
        return { action: "run", due, freshlySeeded: [...freshlySeeded] };
      },
    );

    if (decision.action === "defer") return;

    // The seed transaction must commit before the retired units are disabled. A crash
    // before this point leaves the old persistent timers able to cover the night; a
    // crash after it has a durable in-process catch-up baseline.
    if (homedir && existsSync(join(homedir, ".config/systemd/user"))) {
      let probe: ExecResult;
      try {
        probe = execImpl(["--version"]);
      } catch (error) {
        probe = { code: 127, error };
      }
      if (errorCode(probe.error) !== "ENOENT") {
        removeLegacyUnits({ homedir, execImpl, log });
      }
    }

    if (decision.freshlySeeded.length > 0) {
      log(
        `schedule-migration: seeded catch-up baseline for ${decision.freshlySeeded.join(", ")} (storm protection)`,
      );
    }

    // The actual catch-up run (and ITS OWN reservation, under its own fresh lock
    // acquisition inside runScheduledJob) happens outside this critical section — it can
    // take up to the job's full timeoutMs, and holding the status lock for that entire
    // duration would block every other schedule's admission check in the meantime.
    for (const { period, dueAt, effectiveBaseline } of decision.due) {
      const lastSuccess =
        typeof effectiveBaseline === "number" &&
        Number.isFinite(effectiveBaseline)
          ? new Date(effectiveBaseline).toISOString()
          : "never";
      log(
        `schedule-migration: catching up ${period} (due ${new Date(dueAt).toISOString()}, last success ${lastSuccess})`,
      );
      try {
        await runPeriod(period);
      } catch (error) {
        log(
          `schedule-migration: catch-up run for ${period} failed: ${errorMessage(error)}`,
        );
      }
    }
  } catch (error) {
    try {
      log(`schedule-migration: unexpected failure: ${errorMessage(error)}`);
    } catch {
      // logging must never be able to throw out of this function
    }
  }
}
