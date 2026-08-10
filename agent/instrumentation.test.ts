/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { PROBE_FLAG } from "./lib/eve-health.ts";
import instrumentation from "./instrumentation.ts";

/** Run the server-start hook with console output captured. */
function boot(t: { after(fn: () => void): void }): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  t.after(() => {
    console.log = original;
  });
  instrumentation.setup?.();
  return lines;
}

test("a start that is an update's health probe migrates nothing", (t) => {
  process.env[PROBE_FLAG] = "1";
  process.env.ASSISTANT_TIMEZONE = "Asia/Tashkent";
  t.after(() => {
    delete process.env[PROBE_FLAG];
    delete process.env.ASSISTANT_TIMEZONE;
  });

  const lines = boot(t);

  // The probe start is the one start that must leave the installation alone: the
  // migration retires systemd units and can spawn a rollup, and the version it
  // would do that for is one the installation has not accepted yet.
  assert.deepEqual(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /schedule-migration: skipped/u);
  assert.match(lines[0], /health probe/u);
  // The timezone is still applied: it decides what the process thinks "now" is,
  // and a probe that starts in the wrong one proves the wrong thing.
  assert.equal(process.env.TZ, "Asia/Tashkent");
});
