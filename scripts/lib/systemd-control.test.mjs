import { strict as assert } from "node:assert";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as systemdControl from "./systemd-control.mjs";

const { createSystemdControl } = systemdControl;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = "iva-systemd-test-secret-do-not-log";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "iva-systemd-activation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = join(dir, "iva");
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  const calls = join(dir, "systemctl.calls");
  const state = join(dir, "systemd-state");
  const envPath = join(project, ".env");
  const userbotDir = join(project, "services/telegram-userbot");
  await mkdir(join(project, "bin"), { recursive: true });
  await mkdir(join(project, ".output/server"), { recursive: true });
  await mkdir(join(userbotDir, ".venv/bin"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(state, { recursive: true });
  await copyFile(join(ROOT, "bin/iva.mjs"), join(project, "bin/iva.mjs"));
  await symlink(join(ROOT, "scripts"), join(project, "scripts"), "dir");
  await symlink(join(ROOT, "deploy"), join(project, "deploy"), "dir");
  await writeFile(join(project, ".output/server/index.mjs"), "");
  await copyFile(
    join(ROOT, "services/telegram-userbot/requirements.lock"),
    join(userbotDir, "requirements.lock"),
  );
  await writeFile(join(userbotDir, ".venv/bin/python"), "#!/bin/sh\nexit 0\n");
  await chmod(join(userbotDir, ".venv/bin/python"), 0o755);
  await writeFile(
    envPath,
    `MODEL_PROVIDER=codex\nOPENAI_API_KEY=${SECRET}\nTELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=old-desired-hash\n`,
    { mode: 0o600 },
  );

  const fakeUv = join(fakeBin, "uv");
  await writeFile(fakeUv, "#!/bin/sh\nexit 0\n");
  await chmod(fakeUv, 0o755);

  const fakeSystemctl = join(fakeBin, "systemctl");
  await writeFile(
    fakeSystemctl,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$IVA_FAKE_SYSTEMCTL_CALLS"',
      '[ "$1" = "--user" ] && shift',
      'action="$1"',
      "shift",
      'if [ "${IVA_FAKE_SYSTEMCTL_EXIT:-0}" -ne 0 ] && { [ -z "${IVA_FAKE_FAIL_ACTION:-}" ] || [ "$IVA_FAKE_FAIL_ACTION" = "$action" ]; }; then',
      '  printf "fake systemctl failure: %s\\n" "$IVA_FAKE_SECRET_OUTPUT" >&2',
      '  exit "$IVA_FAKE_SYSTEMCTL_EXIT"',
      "fi",
      'case "$action" in',
      "  enable)",
      '    [ "${1:-}" = "--now" ] && shift',
      '    unit="$1"',
      '    : > "$IVA_FAKE_SYSTEMD_STATE/$unit.enabled"',
      '    if [ "${IVA_FAKE_INACTIVE_UNIT:-}" != "$unit" ]; then : > "$IVA_FAKE_SYSTEMD_STATE/$unit.active"; fi',
      "    ;;",
      "  restart)",
      '    unit="$1"',
      '    if [ "${IVA_FAKE_INACTIVE_UNIT:-}" != "$unit" ]; then : > "$IVA_FAKE_SYSTEMD_STATE/$unit.active"; fi',
      "    ;;",
      "  stop)",
      '    rm -f "$IVA_FAKE_SYSTEMD_STATE/$1.active"',
      "    ;;",
      "  disable)",
      '    [ "${1:-}" = "--now" ] && shift',
      '    rm -f "$IVA_FAKE_SYSTEMD_STATE/$1.enabled" "$IVA_FAKE_SYSTEMD_STATE/$1.active"',
      "    ;;",
      "  is-enabled)",
      '    if [ -f "$IVA_FAKE_SYSTEMD_STATE/$1.enabled" ]; then echo enabled; else echo disabled; exit 1; fi',
      "    ;;",
      "  is-active)",
      '    if [ -f "$IVA_FAKE_SYSTEMD_STATE/$1.active" ]; then echo active; else echo inactive; exit 3; fi',
      "    ;;",
      "  is-failed)",
      '    if [ "${IVA_FAKE_FAILED_UNIT:-}" = "$1" ]; then echo failed; else echo inactive; exit 1; fi',
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(fakeSystemctl, 0o755);

  const runCommand = (
    command,
    { args = [], exit = 0, failAction = "", inactiveUnit = "", failedUnit = "" } = {},
  ) =>
    spawnSync(process.execPath, [join(project, "bin/iva.mjs"), command, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: "1",
        PATH: `${fakeBin}:/usr/bin:/bin`,
        IVA_FAKE_SYSTEMCTL_CALLS: calls,
        IVA_FAKE_SYSTEMCTL_EXIT: String(exit),
        IVA_FAKE_FAIL_ACTION: failAction,
        IVA_FAKE_SECRET_OUTPUT: SECRET,
        IVA_FAKE_SYSTEMD_STATE: state,
        IVA_FAKE_INACTIVE_UNIT: inactiveUnit,
        IVA_FAKE_FAILED_UNIT: failedUnit,
      },
    });

  return {
    calls,
    envPath,
    home,
    project,
    runStart: (exit = 0) => runCommand("start", { exit }),
    runCommand,
    async seedQuarantineFailure() {
      const eveDir = join(project, ".eve");
      await mkdir(join(eveDir, ".workflow-data"), { recursive: true });
      await chmod(eveDir, 0o500);
    },
    async seedUnit(unit) {
      await writeFile(join(state, `${unit}.enabled`), "");
      await writeFile(join(state, `${unit}.active`), "");
    },
  };
}

test("iva start propagates a systemctl enable failure", async (t) => {
  const { runStart } = await fixture(t);
  const result = runStart(1);

  assert.equal(result.status, 1, result.stderr || result.stdout);
});

test("iva start does not print success after a systemctl enable failure", async (t) => {
  const { runStart } = await fixture(t);
  const result = runStart(1);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.doesNotMatch(output, /Started and enabled at boot/);
});

test("iva start is idempotent when systemctl reports success", async (t) => {
  const { calls, runStart } = await fixture(t);
  const first = runStart();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstCalls = (await readFile(calls, "utf8")).trim().split("\n");

  const second = runStart();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const allCalls = (await readFile(calls, "utf8")).trim().split("\n");

  assert.deepEqual(allCalls.slice(firstCalls.length), firstCalls);
});

test("iva start diagnostics do not expose .env secrets", async (t) => {
  const { runStart } = await fixture(t);
  const result = runStart(1);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.doesNotMatch(output, new RegExp(SECRET));
});

test("iva start reports the exact unit journal after activation fails", async (t) => {
  const { runStart } = await fixture(t);
  const result = runStart(1);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.match(output, /journalctl --user -u iva\.service -n 100 --no-pager/);
  assert.doesNotMatch(output, /fake systemctl failure/);
});

test("iva start waits for enabled and active postconditions", async (t) => {
  const { runCommand } = await fixture(t);
  const result = runCommand("start", { inactiveUnit: "iva.service" });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /iva\.service did not become active/);
  assert.doesNotMatch(output, /Started and enabled at boot/);
});

test("installer activation seam uses the same checked CLI path", async (t) => {
  const { runCommand } = await fixture(t);
  const result = runCommand("_activate-units", { exit: 1 });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const installer = await readFile(join(ROOT, "install.sh"), "utf8");
  assert.match(installer, /bin\/iva\.mjs" _activate-units/);
  assert.doesNotMatch(installer, /^\s*systemctl --user enable --now/m);
});

test("doctor reports checked activation failures and keeps its summary", async (t) => {
  const { runCommand } = await fixture(t);
  const result = runCommand("doctor", { exit: 1, failAction: "enable" });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /journalctl --user -u iva\.service -n 100 --no-pager/);
  assert.match(output, /Summary:/);
  assert.doesNotMatch(output, /Units installed, enabled and active/);
});

test("doctor checks installed memory services and reports failed ones with a journal hint", async (t) => {
  // daily/weekly/monthly/yearly moved to in-process eve schedules (agent/schedules/memory-*.ts,
  // see scripts/lib/schedule-migration.mjs) — doctor stays the only external systemd watchdog.
  const { calls, runCommand } = await fixture(t);
  const result = runCommand("doctor", { failedUnit: "iva-memory-doctor.service" });
  const output = `${result.stdout}\n${result.stderr}`;
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");
  const checked = systemctlCalls
    .filter((call) => call.startsWith("--user is-failed iva-memory-"))
    .map((call) => call.split(" ").at(-1));

  assert.equal(result.status, 1, output);
  assert.deepEqual(checked, ["iva-memory-doctor.service"]);
  assert.match(output, /iva-memory-doctor\.service failed/);
  assert.match(output, /journalctl --user -u iva-memory-doctor\.service -n 100 --no-pager/);
});

test("doctor checks all four rollup periods against their own staleness threshold", async (t) => {
  const { project, runCommand } = await fixture(t);
  const now = Date.now();
  await mkdir(join(project, "data"), { recursive: true });
  await writeFile(
    join(project, "data/rollup-status.json"),
    JSON.stringify({
      "memory-daily": { lastSuccessAt: now - 27 * 60 * 60 * 1000 },       // > 26h -> stale
      "memory-weekly": { lastSuccessAt: now - 2 * 24 * 60 * 60 * 1000 },  // < 8d -> fresh
      "memory-monthly": { lastSuccessAt: now - 33 * 24 * 60 * 60 * 1000 }, // > 32d -> stale
      "memory-yearly": { lastSuccessAt: now - 10 * 24 * 60 * 60 * 1000 }, // < 370d -> fresh
    }),
  );

  const result = runCommand("doctor");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.match(output, /memory-daily schedule hasn't succeeded/);
  assert.match(output, /memory-monthly schedule hasn't succeeded/);
  assert.doesNotMatch(output, /memory-weekly schedule hasn't succeeded/);
  assert.doesNotMatch(output, /memory-yearly schedule hasn't succeeded/);
  assert.match(output, /memory-weekly schedule last succeeded/);
  assert.match(output, /memory-yearly schedule last succeeded/);
});

test("doctor warns on a non-zero last exit code even right after a fresh success", async (t) => {
  const { project, runCommand } = await fixture(t);
  const now = Date.now();
  await mkdir(join(project, "data"), { recursive: true });
  await writeFile(
    join(project, "data/rollup-status.json"),
    JSON.stringify({
      // Recently succeeded (well inside the 26h daily threshold)...
      "memory-daily": { lastSuccessAt: now - 60 * 60 * 1000, lastExitCode: 1 },
      // ...but the run recorded here is the LATEST attempt, and it failed after that
      // success (e.g. a retry). The staleness check alone would call this fine.
    }),
  );

  const result = runCommand("doctor");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.match(output, /memory-daily schedule last succeeded/);
  assert.match(output, /memory-daily schedule's last run exited 1/);
});

test("legacy memory-timer cleanup is skipped when the current build doesn't contain the eve schedules yet", async (t) => {
  const { home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, "iva-memory-daily.timer"), "[Unit]\n");
  // The fixture's stub .output/server/index.mjs is empty — no schedule names in it,
  // i.e. exactly what a build made before this migration landed looks like.
  await writeFile(join(project, ".output/server/index.mjs"), "");

  const result = runCommand("_install-units");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /skipping legacy memory-timer cleanup/);
  assert.equal(existsSync(join(unitDir, "iva-memory-daily.timer")), true, "the legacy unit is left alone on a stale build");
});

test("legacy memory-timer cleanup proceeds once the build actually contains the eve schedules", async (t) => {
  const { calls, home, project, runCommand } = await fixture(t);
  const unitDir = join(home, ".config/systemd/user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, "iva-memory-daily.timer"), "[Unit]\n");
  await mkdir(join(project, ".output/server/_virtual"), { recursive: true });
  await writeFile(
    join(project, ".output/server/_virtual/eve.schedule.mjs"),
    'export const scheduleId = "memory-daily";\n',
  );

  const result = runCommand("_install-units");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /skipping legacy memory-timer cleanup/);
  assert.equal(existsSync(join(unitDir, "iva-memory-daily.timer")), false, "a build that has the schedules lets cleanup proceed");
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");
  assert.ok(systemctlCalls.some((c) => c === "--user disable --now iva-memory-daily.timer"));
});

test("doctor surfaces problems from a fresh nightly memory report", async (t) => {
  const { project, runCommand } = await fixture(t);
  const graph = join(project, "vault/.graph");
  await mkdir(graph, { recursive: true });
  await writeFile(
    join(graph, "enforce-report.json"),
    JSON.stringify({ review: 2, duplicates: 1, skipped_oversize: 3, unknown: 99 }),
  );

  const result = runCommand("doctor");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.match(output, /ночной maintenance сообщает о проблемах: review=2, duplicates=1, skipped_oversize=3/);
  assert.doesNotMatch(output, /unknown=99/);
});

test("userbot setup restarts an already enabled and active unit for new desired config", async (t) => {
  const { calls, envPath, runCommand, seedUnit } = await fixture(t);
  await seedUnit("iva-telegram-userbot.service");
  await writeFile(
    envPath,
    `MODEL_PROVIDER=codex\nOPENAI_API_KEY=${SECRET}\nTELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=new-desired-hash\n`,
    { mode: 0o600 },
  );

  const result = runCommand("userbot", { args: ["setup"] });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const systemctlCalls = (await readFile(calls, "utf8")).trim().split("\n");
  const enableAt = systemctlCalls.indexOf("--user enable --now iva-telegram-userbot.service");
  const restartAt = systemctlCalls.indexOf("--user restart iva-telegram-userbot.service");

  assert.ok(enableAt >= 0, systemctlCalls.join("\n"));
  assert.ok(restartAt > enableAt, systemctlCalls.join("\n"));
});

test("every systemd mutation rejects a non-zero command", () => {
  const control = createSystemdControl({
    run: () => ({ code: 1, out: "", err: `ignored ${SECRET}` }),
  });

  const rejectsSafely = (action) =>
    assert.throws(action, (error) => {
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    });

  rejectsSafely(() => control.activate(["iva.service"]));
  rejectsSafely(() => control.restart(["iva.service"]));
  rejectsSafely(() => control.stop(["iva.service"]));
  rejectsSafely(() => control.disableNow(["iva.service"]));
  rejectsSafely(() => control.resetFailed(["iva.service"]));
  rejectsSafely(() => control.daemonReload());
});

test("iva reset keeps quarantine-only and restart-only diagnostics distinct", async (t) => {
  await t.test("quarantine failure only", async (t) => {
    const { runCommand, seedQuarantineFailure } = await fixture(t);
    await seedQuarantineFailure();
    const result = runCommand("reset");
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /Reset INCOMPLETE/);
    assert.doesNotMatch(output, /systemctl --user restart .* failed/);
  });

  await t.test("restart failure only", async (t) => {
    const { runCommand } = await fixture(t);
    const result = runCommand("reset", { exit: 1, failAction: "restart" });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /systemctl --user restart iva\.service failed/);
    assert.doesNotMatch(output, /Reset INCOMPLETE/);
  });
});

test("iva reset reports both failures when quarantine and restart fail", async (t) => {
  const { runCommand, seedQuarantineFailure } = await fixture(t);
  await seedQuarantineFailure();
  const result = runCommand("reset", { exit: 1, failAction: "restart" });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /systemctl --user restart iva\.service failed/);
  assert.match(output, /Reset INCOMPLETE/);
  assert.doesNotMatch(output, new RegExp(SECRET));
  assert.doesNotMatch(output, /fake systemctl failure/);
});

test("unit removal finishes every cleanup step before reporting aggregated failures", () => {
  const calls = [];
  const units = ["iva.service", "iva-update-check.timer"];
  let successReported = false;

  assert.throws(
    () => {
      systemdControl.cleanupSystemdUnits({
        units,
        disable: (unit) => {
          calls.push(`disable:${unit}`);
          if (unit === "iva.service") throw new Error("disable failed");
        },
        remove: (unit) => {
          calls.push(`remove:${unit}`);
        },
        reload: () => {
          calls.push("reload");
          throw new Error("reload failed");
        },
        reset: () => {
          calls.push("reset");
        },
      });
      successReported = true;
    },
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /disable iva\.service: disable failed/);
      assert.match(error.message, /daemon-reload: reload failed/);
      return true;
    },
  );

  assert.equal(successReported, false);
  assert.deepEqual(calls, [
    "disable:iva.service",
    "disable:iva-update-check.timer",
    "remove:iva.service",
    "remove:iva-update-check.timer",
    "reload",
    "reset",
  ]);
});
