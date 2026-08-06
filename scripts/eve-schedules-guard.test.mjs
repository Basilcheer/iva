// CI guard for the systemd-timers -> eve-schedules migration (see CHANGELOG.md
// Unreleased, docs/deploy.md, scripts/lib/schedule-migration.ts): catches a future
// change that accidentally reintroduces one of the retired deploy/ unit files, or
// silently changes the shape of agent/schedules/ (a stray extra/missing file there
// changes what `eve info` reports and what schedule-migration.ts's catch-up covers).
import { strict as assert } from "node:assert";
import test from "node:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("deploy/ contains none of the 8 retired iva-memory-{daily,weekly,monthly,yearly} unit files", () => {
  const files = readdirSync(join(ROOT, "deploy"));
  const retired = files.filter((f) =>
    /^iva-memory-(daily|weekly|monthly|yearly)\.(service|timer)$/.test(f),
  );
  assert.deepEqual(
    retired,
    [],
    "these units moved to agent/schedules/*.ts — see scripts/lib/schedule-migration.ts",
  );
  // The doctor timer is the one memory-related unit that stays on systemd on purpose.
  assert.ok(files.includes("iva-memory-doctor.service"));
  assert.ok(files.includes("iva-memory-doctor.timer"));
});

test("agent/schedules/ contains exactly the 5 expected eve schedules", () => {
  const files = readdirSync(join(ROOT, "agent/schedules")).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".md"),
  );
  assert.deepEqual(
    [...files].sort(),
    [
      "digest.ts",
      "memory-daily.ts",
      "memory-monthly.ts",
      "memory-weekly.ts",
      "memory-yearly.ts",
    ].sort(),
  );
});
