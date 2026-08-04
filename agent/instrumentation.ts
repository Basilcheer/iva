// Server-start hook (eve auto-discovers this file and runs it before any agent code).
// Two jobs, both side effects, no telemetry actually configured here:
//
//   1. TZ fallback so the process' local time (used by cron-parsed schedules below, which
//      fire in the process's OWN local time — eve schedules carry no timezone of their
//      own) matches ASSISTANT_TIMEZONE instead of defaulting to the host's system TZ.
//   2. fire-and-forget the systemd → eve-schedules migration (retire the old memory-rollup
//      timers, catch up a missed period). This is the one reliable point in the codebase
//      that always runs on the NEW server, even right after an `iva update` executed by
//      the OLD CLI (bin/iva.mjs cmdUpdate doesn't know about eve schedules at all).
//
// recordInputs/recordOutputs: false — this file's mere presence implicitly enables eve's
// authored-telemetry path (see eve/docs/guides/instrumentation.md) and disables the
// zero-config local dev tracer; since no OTel exporter is registered below, telemetry is
// otherwise inert, but a stray default of `true` would still turn on payload capture we
// never asked for. Keep `eve dev` startup unaffected — verified by `timeout 30 npx eve dev`.
import { join } from "node:path";
import { homedir } from "node:os";
import { defineInstrumentation } from "eve/instrumentation";
import { runScheduleMigration } from "../scripts/lib/schedule-migration.mjs";

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

export default defineInstrumentation({
  recordInputs: false,
  recordOutputs: false,
  setup() {
    // Same fallback the poller/rollup scripts use — see scripts/poller/config.mjs — kept
    // here too because Nitro's schedule runner (unlike those) reads no .env of its own.
    // Plain `||=` would coerce a genuinely unset ASSISTANT_TIMEZONE into the literal
    // string "undefined" (process.env assignments always stringify), which then makes
    // Intl.DateTimeFormat throw — so only assign when there is an actual value to assign.
    if (!process.env.TZ && process.env.ASSISTANT_TIMEZONE) {
      process.env.TZ = process.env.ASSISTANT_TIMEZONE;
    }
    const tz =
      process.env.ASSISTANT_TIMEZONE ||
      (process.env.TZ && process.env.TZ !== "undefined" ? process.env.TZ : "UTC");

    // Never let this block or fail server startup: wrap synchronously, and treat the
    // returned promise as fire-and-forget with its own catch.
    try {
      const root = process.cwd();
      const dataDirRaw = process.env.ASSISTANT_DATA_DIR ?? "data";
      const dataDir = dataDirRaw.startsWith("/") ? dataDirRaw : join(root, dataDirRaw);
      runScheduleMigration({
        homedir: homedir(),
        statusPath: join(dataDir, "rollup-status.json"),
        tz,
        root,
        nodeBin: process.execPath,
        log,
      }).catch((error: unknown) => {
        log("schedule-migration failed:", error instanceof Error ? error.message : String(error));
      });
    } catch (error) {
      log("schedule-migration setup failed:", error instanceof Error ? error.message : String(error));
    }
  },
});
