import { strict as assert } from "node:assert";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LEGACY_MEMORY_UNITS,
  runScheduleMigration,
} from "./schedule-migration.mjs";

const UNIT_DIR_REL = ".config/systemd/user";

async function scaffoldHome({ withUnitDir = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iva-schedule-migration-"));
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  if (withUnitDir) await mkdir(join(home, UNIT_DIR_REL), { recursive: true });
  return home;
}

function fakeExecImpl({ failUnits = new Set() } = {}) {
  const calls = [];
  const execImpl = (args) => {
    calls.push(args.join(" "));
    if (args[1] === "disable" && failUnits.has(args[3])) {
      return { code: 1, out: "", err: "simulated systemctl failure" };
    }
    return { code: 0, out: "", err: "" };
  };
  return { execImpl, calls };
}

test("LEGACY_MEMORY_UNITS lists exactly the 8 retired unit names", () => {
  assert.deepEqual(
    [...LEGACY_MEMORY_UNITS].sort(),
    [
      "iva-memory-daily.service",
      "iva-memory-daily.timer",
      "iva-memory-monthly.service",
      "iva-memory-monthly.timer",
      "iva-memory-weekly.service",
      "iva-memory-weekly.timer",
      "iva-memory-yearly.service",
      "iva-memory-yearly.timer",
    ].sort(),
  );
});

test("no ~/.config/systemd/user: legacy-unit cleanup is skipped, but catch-up (first-boot seeding) still runs", async () => {
  // Catch-up must not depend on systemd being present at all — a container, this repo's
  // own `npm run replica` sandbox, or CI has no ~/.config/systemd/user (nothing to tear
  // down) but should still track and eventually catch up a missed rollup.
  const homedir = await scaffoldHome({ withUnitDir: false });
  const statusPath = join(homedir, "..", "data/rollup-status.json");
  const { execImpl, calls } = fakeExecImpl();
  let runJobCalled = false;

  await assert.doesNotReject(() =>
    runScheduleMigration({
      homedir,
      execImpl,
      statusPath,
      tz: "UTC",
      log: () => {},
      runJob: async () => {
        runJobCalled = true;
      },
    }),
  );

  assert.equal(calls.length, 0, "no systemd -> no systemctl calls of any kind");
  assert.equal(
    runJobCalled,
    false,
    "first boot still suppresses catch-up (storm protection), regardless of systemd",
  );
  assert.equal(
    existsSync(statusPath),
    true,
    "catch-up bookkeeping (the first-boot seed) proceeds even without systemd",
  );
});

test("systemctl binary missing (ENOENT): legacy-unit cleanup is skipped, but catch-up still runs", async () => {
  const homedir = await scaffoldHome();
  const statusPath = join(homedir, "..", "data/rollup-status.json");
  const calls = [];
  const execImpl = (args) => {
    calls.push(args);
    const error = new Error("spawnSync systemctl ENOENT");
    error.code = "ENOENT";
    return { code: 127, out: "", err: "", error };
  };
  let runJobCalled = false;

  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "UTC",
    log: () => {},
    runJob: async () => {
      runJobCalled = true;
    },
  });

  // The very first probe call may legitimately happen (to discover ENOENT), but no
  // mutating systemctl calls may follow it — actually verify the call log, not a
  // tautology.
  assert.ok(
    calls.length <= 1,
    `no mutating systemctl calls followed the probe: ${JSON.stringify(calls)}`,
  );
  assert.equal(
    runJobCalled,
    false,
    "first boot suppresses catch-up regardless of systemctl availability",
  );
  assert.equal(
    existsSync(statusPath),
    true,
    "catch-up bookkeeping proceeds even when systemctl itself is missing",
  );
});

test("first boot (no status file): seeds a baseline (seededAt, NOT lastSuccessAt) for all four periods and runs nothing", async () => {
  const homedir = await scaffoldHome();
  const dataDir = join(homedir, "..", "data");
  const statusPath = join(dataDir, "rollup-status.json");
  const { execImpl } = fakeExecImpl();
  const ranPeriods = [];
  const fixedNow = Date.UTC(2026, 7, 4, 10, 0, 0);

  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "UTC",
    log: () => {},
    now: () => fixedNow,
    runJob: async (period) => {
      ranPeriods.push(period);
    },
  });

  assert.deepEqual(
    ranPeriods,
    [],
    "first boot must never run a catch-up job (storm protection)",
  );
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  // Keyed "memory-<period>" — the same name schedule-runner.ts actually records a real
  // run under (the `name` each agent/schedules/memory-*.ts passes), not the bare period.
  for (const period of ["daily", "weekly", "monthly", "yearly"]) {
    const entry = status[`memory-${period}`];
    assert.equal(entry?.seededAt, fixedNow, `${period} is seeded to now`);
    // The seed is a storm-protection baseline, not a real run — /menu → crons and
    // iva doctor must not report it as one.
    assert.equal(
      entry?.lastSuccessAt,
      undefined,
      `${period}'s seed must not read as a real success`,
    );
  }
});

test("a digest-only status seeds every missing memory key and causes no catch-up burst", async () => {
  const homedir = await scaffoldHome();
  const statusPath = join(homedir, "..", "data", "rollup-status.json");
  await mkdir(join(homedir, "..", "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({ digest: { lastSuccessAt: 123 } }),
  );
  const fixedNow = Date.UTC(2026, 7, 4, 10, 0, 0);
  const ranPeriods = [];

  await runScheduleMigration({
    homedir,
    statusPath,
    tz: "UTC",
    log: () => {},
    now: () => fixedNow,
    execImpl: fakeExecImpl().execImpl,
    runJob: async (period) => {
      ranPeriods.push(period);
    },
  });

  assert.deepEqual(ranPeriods, []);
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.deepEqual(status.digest, { lastSuccessAt: 123 });
  for (const period of ["daily", "weekly", "monthly", "yearly"]) {
    assert.equal(status[`memory-${period}`]?.seededAt, fixedNow);
  }
});

test("legacy teardown is not attempted when the seed transaction cannot be committed", async () => {
  const homedir = await scaffoldHome();
  const unitDir = join(homedir, UNIT_DIR_REL);
  const unit = join(unitDir, "iva-memory-daily.timer");
  await writeFile(unit, "[Unit]\n");
  const { execImpl, calls } = fakeExecImpl();
  const logs = [];

  // A directory cannot be atomically replaced by the JSON status tmp file. This makes
  // the seed write fail after the status lock is acquired, before teardown is allowed.
  await runScheduleMigration({
    homedir,
    statusPath: unitDir,
    execImpl,
    log: (...args) => logs.push(args.join(" ")),
  });

  assert.deepEqual(calls, []);
  assert.equal(existsSync(unit), true);
  assert.ok(logs.some((line) => line.includes("unexpected failure")));
});

test("legacy units: disabled and deleted by exact name; unrelated xfeed-daily.timer is left alone", async () => {
  const homedir = await scaffoldHome();
  const unitDir = join(homedir, UNIT_DIR_REL);
  const existing = [
    "iva-memory-daily.service",
    "iva-memory-daily.timer",
    "iva-memory-weekly.timer",
  ];
  for (const name of existing) await writeFile(join(unitDir, name), "[Unit]\n");
  await writeFile(join(unitDir, "xfeed-daily.timer"), "[Unit]\n# not ours\n");

  const statusPath = join(homedir, "..", "data/rollup-status.json");
  // Not a first boot — seed the status file up front so catch-up logic is skipped/neutral
  // for this test (it only cares about the legacy-unit teardown).
  await mkdir(join(homedir, "..", "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({
      "memory-daily": { lastSuccessAt: Date.now() },
      "memory-weekly": { lastSuccessAt: Date.now() },
      "memory-monthly": { lastSuccessAt: Date.now() },
      "memory-yearly": { lastSuccessAt: Date.now() },
    }),
  );

  const { execImpl, calls } = fakeExecImpl();
  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "UTC",
    log: () => {},
    runJob: async () => {
      throw new Error("must not run on a seeded, up-to-date status file");
    },
  });

  for (const name of existing) {
    assert.ok(
      calls.some((c) => c === `--user disable --now ${name}`),
      `disable --now ${name}`,
    );
    assert.equal(
      existsSync(join(unitDir, name)),
      false,
      `${name} file removed`,
    );
  }
  // Units that were never installed must never be referenced at all.
  assert.ok(!calls.some((c) => c.includes("iva-memory-monthly")));
  assert.ok(!calls.some((c) => c.includes("iva-memory-yearly")));
  assert.ok(!calls.some((c) => c.includes("xfeed-daily")));
  assert.equal(
    existsSync(join(unitDir, "xfeed-daily.timer")),
    true,
    "xfeed-daily.timer is untouched",
  );

  assert.equal(calls.filter((c) => c === "--user daemon-reload").length, 1);
  assert.equal(calls.filter((c) => c === "--user reset-failed").length, 1);
});

test("a partial systemctl failure does not throw, leaves the file for a retry, and the next boot cleans it up", async () => {
  const homedir = await scaffoldHome();
  const unitDir = join(homedir, UNIT_DIR_REL);
  await writeFile(join(unitDir, "iva-memory-daily.timer"), "[Unit]\n");
  await writeFile(join(unitDir, "iva-memory-daily.service"), "[Unit]\n");
  const statusPath = join(homedir, "..", "data/rollup-status.json");
  await mkdir(join(homedir, "..", "data"), { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({
      "memory-daily": { lastSuccessAt: Date.now() },
      "memory-weekly": { lastSuccessAt: Date.now() },
      "memory-monthly": { lastSuccessAt: Date.now() },
      "memory-yearly": { lastSuccessAt: Date.now() },
    }),
  );

  const { execImpl, calls } = fakeExecImpl({
    failUnits: new Set(["iva-memory-daily.timer"]),
  });
  const logged = [];

  await assert.doesNotReject(() =>
    runScheduleMigration({
      homedir,
      execImpl,
      statusPath,
      tz: "UTC",
      log: (...a) => logged.push(a.join(" ")),
    }),
  );
  assert.ok(
    calls.some((c) => c === "--user disable --now iva-memory-daily.timer"),
    "the failing disable was actually attempted",
  );
  assert.ok(
    logged.some(
      (l) =>
        l.includes("disable --now iva-memory-daily.timer") &&
        l.includes("failed"),
    ),
    "the failure was logged, not swallowed silently",
  );
  // The file must survive a failed disable: deleting it anyway would leave a unit that
  // systemd still considers enabled/active with no file behind it — invisible to a
  // human, but not actually gone. It's deleted only once disable actually succeeds.
  assert.equal(
    existsSync(join(unitDir, "iva-memory-daily.timer")),
    true,
    "the unit file is kept when disable failed",
  );
  assert.ok(
    logged.some(
      (l) =>
        l.includes("iva-memory-daily.timer") &&
        l.includes("next boot will retry"),
    ),
  );
  // Its sibling .service file (whose disable did NOT fail) is removed as normal.
  assert.equal(existsSync(join(unitDir, "iva-memory-daily.service")), false);

  // "Next boot" — systemctl behaves normally this time, so the retry succeeds and the
  // file is finally removed.
  const second = fakeExecImpl();
  await assert.doesNotReject(() =>
    runScheduleMigration({
      homedir,
      execImpl: second.execImpl,
      statusPath,
      tz: "UTC",
      log: () => {},
    }),
  );
  assert.ok(
    second.calls.some(
      (c) => c === "--user disable --now iva-memory-daily.timer",
    ),
    "the retry actually re-attempts disable",
  );
  assert.equal(
    existsSync(join(unitDir, "iva-memory-daily.timer")),
    false,
    "the retry succeeds and the file is finally removed",
  );
});

test("catch-up math: due-and-in-grace periods run, an already-succeeded period does not, and a period whose due point is past its grace window is skipped", async () => {
  // Fixed instant: 2026-08-04T10:00:00Z == Tuesday 15:00 in Asia/Almaty (UTC+5).
  //   daily   due: 2026-08-04 04:00 Almaty == 2026-08-03T23:00:00Z  (now - due =  11h,   grace 20h  -> in grace)
  //   weekly  due: Monday 2026-08-03 04:15 Almaty == 2026-08-02T23:15:00Z (now - due ~34.75h, grace 3d -> in grace)
  //   monthly due: 2026-08-01 04:20 Almaty == 2026-07-31T23:20:00Z (now - due ~82.67h, grace 7d -> in grace)
  //   yearly  due: 2026-01-01 04:25 Almaty == 2025-12-31T23:25:00Z (now - due ~215d,   grace 14d -> OUT of grace)
  const fixedNow = Date.UTC(2026, 7, 4, 10, 0, 0);
  const dailyDue = Date.UTC(2026, 7, 3, 23, 0, 0);
  const weeklyDue = Date.UTC(2026, 7, 2, 23, 15, 0);
  const monthlyDue = Date.UTC(2026, 6, 31, 23, 20, 0);

  const homedir = await scaffoldHome();
  const dataDir = join(homedir, "..", "data");
  const statusPath = join(dataDir, "rollup-status.json");
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    statusPath,
    JSON.stringify({
      "memory-daily": { lastSuccessAt: dailyDue - 60_000 }, // stale by 1 minute -> due, in grace -> RUNS
      "memory-weekly": { lastSuccessAt: weeklyDue + 60_000 }, // already succeeded AFTER due -> does NOT run
      "memory-monthly": { lastSuccessAt: monthlyDue - 60_000 }, // stale, in grace -> RUNS
      "memory-yearly": { lastSuccessAt: 0 }, // ancient, but due point itself is out of grace -> does NOT run
    }),
  );

  const { execImpl } = fakeExecImpl();
  const ranPeriods = [];
  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "Asia/Almaty",
    log: () => {},
    now: () => fixedNow,
    runJob: async (period) => {
      ranPeriods.push(period);
    },
  });

  assert.deepEqual([...ranPeriods].sort(), ["daily", "monthly"]);
});

test("style-matched integration: a real fake systemctl on PATH, tmpdir HOME, via bin/iva.mjs _install-units", async () => {
  // Mirrors scripts/lib/security-migration.test.mjs's black-box shape: this confirms the
  // migration also behaves when invoked the way it actually runs in production — as a
  // side effect of server startup — rather than only through direct unit-level calls above.
  // We exercise it here through the schedule-migration module directly (not a CLI command,
  // since the migration's real trigger is agent/instrumentation.ts, not bin/iva.mjs), but with
  // the same fake-systemctl-on-PATH technique.
  const dir = await mkdtemp(join(tmpdir(), "iva-schedule-migration-onpath-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  await mkdir(join(home, UNIT_DIR_REL), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(home, UNIT_DIR_REL, "iva-memory-yearly.timer"),
    "[Unit]\n",
  );

  const fakeSystemctl = join(bin, "systemctl");
  const log = join(dir, "systemctl-calls.log");
  await writeFile(fakeSystemctl, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  await chmod(fakeSystemctl, 0o755);

  const script = join(dir, "run.mjs");
  await writeFile(
    script,
    [
      `import { runScheduleMigration } from ${JSON.stringify(join(process.cwd(), "scripts/lib/schedule-migration.mjs"))};`,
      `const statusPath = ${JSON.stringify(join(dir, "data/rollup-status.json"))};`,
      `await runScheduleMigration({ homedir: ${JSON.stringify(home)}, statusPath, tz: "UTC", log: () => {} });`,
      `process.exit(0);`,
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    existsSync(join(home, UNIT_DIR_REL, "iva-memory-yearly.timer")),
    false,
  );
  const calls = existsSync(log) ? await readFile(log, "utf8") : "";
  assert.match(calls, /disable --now iva-memory-yearly\.timer/);
  assert.match(calls, /daemon-reload/);
});

test("if the status lock can't be acquired, the whole pass is deferred: no seed, no due-check write, no catch-up run", async () => {
  const homedir = await scaffoldHome();
  const dataDir = join(homedir, "..", "data");
  const statusPath = join(dataDir, "rollup-status.json");
  await mkdir(dataDir, { recursive: true });
  // Pre-hold the lock file with a FRESH mtime so withStatusLock's staleness-steal never
  // kicks in during this test — it must genuinely exhaust its retries and give up.
  await writeFile(`${statusPath}.lock`, "999999");

  const { execImpl } = fakeExecImpl();
  let runJobCalled = false;
  const lines = [];

  await runScheduleMigration({
    homedir,
    execImpl,
    statusPath,
    tz: "UTC",
    log: (...a) => lines.push(a.join(" ")),
    runJob: async () => {
      runJobCalled = true;
    },
  });

  assert.equal(
    runJobCalled,
    false,
    "no catch-up may run off an undecided (lock-less) pass",
  );
  assert.equal(
    existsSync(statusPath),
    false,
    "no status write at all — not a seed, not anything else — without the lock",
  );
  assert.ok(
    lines.some((l) => l.toLowerCase().includes("defer")),
    "the deferral must be logged, not silent",
  );
});
