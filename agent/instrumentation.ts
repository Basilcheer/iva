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
// setup() runs before eve's own HTTP listener is guaranteed to be accepting connections.
// A catch-up run spawns scripts/memory/rollup.ts, which opens an eve/client Client
// against that same listener immediately — spawning it too early is a bare "connection
// refused", not a retryable rollup failure. So the migration itself is only kicked off
// after polling the local health route (the same probeEveHealth used by `iva update`'s
// post-restart check) confirms the listener is actually up, bounded to ~2 minutes; if it
// never comes up in time, this boot's catch-up is skipped (logged) rather than run
// blind — the next boot's migration retries it exactly as it would any other stale period.
//
// recordInputs/recordOutputs: false — this file's mere presence implicitly enables eve's
// authored-telemetry path (see eve/docs/guides/instrumentation.md) and disables the
// zero-config local dev tracer; since no OTel exporter is registered below, telemetry is
// otherwise inert, but a stray default of `true` would still turn on payload capture we
// never asked for. Keep `eve dev` startup unaffected — verified by `timeout 30 npx eve dev`.
import { join } from "node:path";
import { homedir } from "node:os";
import { defineInstrumentation } from "eve/instrumentation";
import { probeEveHealth } from "../scripts/lib/config-transaction.mjs";
import { runScheduleMigration } from "../scripts/lib/schedule-migration.mjs";

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

const LISTENER_READY_TIMEOUT_MS = 120_000;

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
    // whole async chain below as fire-and-forget with its own catch.
    try {
      const root = process.cwd();
      const dataDirRaw = process.env.ASSISTANT_DATA_DIR ?? "data";
      const dataDir = dataDirRaw.startsWith("/") ? dataDirRaw : join(root, dataDirRaw);
      const port = process.env.IVA_PORT ?? "8723";
      const host = (process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
      const healthUrl = `${host}/eve/v1/health`;

      (async () => {
        try {
          await probeEveHealth(healthUrl, { timeoutMs: LISTENER_READY_TIMEOUT_MS });
        } catch (error) {
          log(
            "schedule-migration: HTTP listener not ready within",
            `${LISTENER_READY_TIMEOUT_MS}ms — skipping this boot's catch-up (next boot retries):`,
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
        await runScheduleMigration({
          homedir: homedir(),
          statusPath: join(dataDir, "rollup-status.json"),
          tz,
          root,
          nodeBin: process.execPath,
          log,
        });
      })().catch((error: unknown) => {
        log("schedule-migration failed:", error instanceof Error ? error.message : String(error));
      });
    } catch (error) {
      log("schedule-migration setup failed:", error instanceof Error ? error.message : String(error));
    }
  },
});
