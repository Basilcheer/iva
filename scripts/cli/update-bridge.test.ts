/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createWorld, type World } from "../fixtures/install-world.ts";
import { createVersionStore } from "../lib/version-store.ts";

function world(t: TestContext): World {
  const created = createWorld();
  t.after(() => rmSync(created.dir, { recursive: true, force: true }));
  return created;
}

function update(iva: World): string {
  const result = iva.iva(["update"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  return output;
}

function active(iva: World): string | null {
  return createVersionStore(iva.home).currentName();
}

test("the first update moves the installation onto versions and keeps its state", (t) => {
  const iva = world(t);
  const sha = iva.git(iva.home, ["rev-parse", "HEAD"]);
  writeFileSync(join(iva.home, "data/cards.json"), '{"kept":true}\n');
  // The custom layer of the checkout era could record a stock file as deleted.
  // Nothing carries that across, so the file comes back and the user is told.
  mkdirSync(join(iva.home, "data/custom"), { recursive: true });
  writeFileSync(
    join(iva.home, "data/custom/manifest.json"),
    JSON.stringify({
      schema: "iva-custom/v1",
      entries: {
        "agent/skills/stock/SKILL.md": { tombstone: true },
        "agent/tools/kept.ts": { tombstone: false },
      },
    }),
  );

  const output = update(iva);
  assert.match(output, /agent\/skills\/stock\/SKILL\.md/u);
  assert.doesNotMatch(output, /agent\/tools\/kept\.ts/u);
  const name = `0.3.15-${sha.slice(0, 12)}`;
  assert.equal(active(iva), name, output);
  // The vault cleaner the in-place updater ran still runs, out of the version that
  // has just become current.
  assert.match(
    readFileSync(iva.uvLog, "utf8"),
    new RegExp(
      `^run ${iva.home}/versions/${name}/scripts/autograph/cleanup\\.py \\. --apply$`,
      "mu",
    ),
  );

  const dir = join(iva.home, "versions", name);
  assert.ok(
    existsSync(join(dir, ".output/built.json")),
    "the version was built",
  );
  // State stayed outside the version and is reachable from inside it.
  assert.equal(
    readFileSync(join(dir, "data/cards.json"), "utf8"),
    '{"kept":true}\n',
  );
  assert.equal(
    readFileSync(join(iva.home, ".env"), "utf8").includes("IVA_PORT=8723"),
    true,
  );
  // The checkout is gone; nothing runs from a working tree any more.
  assert.equal(existsSync(join(iva.home, ".git")), false);
  assert.equal(existsSync(join(iva.home, "bin")), false);
  assert.equal(existsSync(join(iva.home, "node_modules")), false);
  for (const kept of ["data", "vault", ".env", ".eve", "repo", "versions"])
    assert.ok(existsSync(join(iva.home, kept)), `${kept} survived`);

  // The shim resolves the active version, and the units name `current` so that
  // garbage-collecting this version later cannot break them.
  assert.match(
    readFileSync(iva.shim, "utf8"),
    /\$IVA_ROOT\/current\/bin\/iva\.mjs/u,
  );
  const unit = readFileSync(
    join(iva.fakeHome, ".config/systemd/user/iva.service"),
    "utf8",
  );
  assert.match(unit, new RegExp(`WorkingDirectory=${iva.home}/current$`, "mu"));
  assert.match(
    unit,
    new RegExp(`${iva.home}/current/node_modules/eve/bin/eve\\.js`, "u"),
  );
  const systemctl = readFileSync(iva.systemctlLog, "utf8");
  assert.match(systemctl, /restart .*iva\.service/u);
  // The auto-update timer has to survive the move, or the install goes quiet.
  assert.match(systemctl, /enable --now iva-update-check\.timer/u);
  // The port migration is recorded once, against the installation's data.
  assert.match(
    readFileSync(join(iva.home, "data/migrations.json"), "utf8"),
    /001-iva-port/u,
  );
});

test("a second update flips to the new version, keeps the previous one and re-runs no migration", (t) => {
  const iva = world(t);
  update(iva);
  const first = active(iva);
  const marker = readFileSync(join(iva.home, "data/migrations.json"), "utf8");

  const sha = iva.publish((tree) =>
    writeFileSync(
      join(tree, "scripts/feature.mjs"),
      "export const feature = 2;\n",
    ),
  );
  const output = update(iva);
  const second = `0.3.15-${sha.slice(0, 12)}`;
  assert.equal(active(iva), second, output);
  assert.notEqual(second, first);
  assert.ok(
    existsSync(join(iva.home, "versions", String(first))),
    "the previous version is kept for a rollback",
  );
  assert.ok(
    existsSync(join(iva.home, "versions", second, "scripts/feature.mjs")),
  );
  assert.equal(
    readFileSync(join(iva.home, "data/migrations.json"), "utf8"),
    marker,
  );
});

test("an update with nothing new is a no-op, and so is one with no network", (t) => {
  const iva = world(t);
  update(iva);
  const name = active(iva);

  const first = iva.iva(["update"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /already up to date/u);
  assert.equal(active(iva), name);

  // The remote disappears entirely: an update must still succeed as a no-op.
  rmSync(iva.upstream, { recursive: true, force: true });
  const offline = iva.iva(["update"]);
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stdout, /already up to date/u);
  assert.equal(active(iva), name);
});

test("a version that builds but does not start is never activated", (t) => {
  const iva = world(t);
  update(iva);
  const healthy = active(iva);
  const store = join(iva.home, ".eve/.workflow-data");
  rmSync(join(store, "started.log"), { force: true });
  rmSync(join(iva.home, "data/started.log"), { force: true });

  iva.publish((tree) =>
    writeFileSync(join(tree, "scripts/feature.mjs"), "// START_BREAK\n"),
  );
  const result = iva.iva(["update"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /provider\.ts/u);
  assert.equal(active(iva), healthy);
  assert.deepEqual(readdirSync(join(iva.home, "versions")), [healthy]);
  // It got as far as opening its state before it died - and none of that reached
  // the installation, which is still being served by the version that works.
  assert.equal(existsSync(join(store, "started.log")), false, output);
  assert.equal(existsSync(join(iva.home, "data/started.log")), false, output);
});

test("the health probe runs on scratch state, with the service's own environment", (t) => {
  const iva = world(t);
  // A run the live service is in the middle of. A probe that borrowed the real
  // store would re-enqueue it from a version that may be deleted a second later.
  const store = join(iva.home, ".eve/.workflow-data");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "open-run.json"), '{"status":"running"}\n');
  // The state paths spelled out absolutely, as `iva config` writes them: fed to
  // the probe unchanged they would aim a throwaway start at the live vault.
  appendFileSync(
    join(iva.home, ".env"),
    `IVA_ENV_MARK=from-dotenv\nASSISTANT_DATA_DIR=${join(iva.home, "data")}\n` +
      `ASSISTANT_VAULT_DIR=${join(iva.home, "vault")}\n`,
  );

  const output = update(iva);
  // systemctl is a stub here, so the only server that really started is the probe.
  const starts = readFileSync(iva.startsLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, string>);
  assert.equal(starts.length, 1, output);
  const [probe] = starts;
  assert.equal(probe.probe, "1", output);
  // The .env systemd hands the unit through EnvironmentFile, or the probe proves
  // a version starts under a configuration nobody runs.
  assert.equal(probe.envMark, "from-dotenv");
  // Both spellings of the port are the probe's own: code that reaches for
  // IVA_PORT to talk to "the server" must not reach the live one.
  assert.equal(probe.ivaPort, probe.port);
  assert.notEqual(probe.ivaPort, "8723");
  // Everything it wrote landed in scratch state.
  assert.notEqual(probe.store, realpathSync(store));
  assert.notEqual(probe.data, realpathSync(join(iva.home, "data")));
  assert.equal(existsSync(join(store, "started.log")), false);
  assert.equal(existsSync(join(iva.home, "data/started.log")), false);
  assert.equal(
    readFileSync(join(store, "open-run.json"), "utf8"),
    '{"status":"running"}\n',
  );

  // Once proved, the version runs on the installation's own state - and keeps no
  // scratch directory around.
  const dir = join(iva.home, "versions", String(active(iva)));
  assert.equal(
    realpathSync(join(dir, ".eve/.workflow-data")),
    realpathSync(store),
  );
  assert.equal(
    realpathSync(join(dir, "data")),
    realpathSync(join(iva.home, "data")),
  );
  assert.equal(existsSync(join(dir, ".iva-incomplete")), false);
});

test("the second half of an update is run by the version being installed", (t) => {
  const iva = world(t);
  update(iva);
  const installed = readFileSync(
    join(iva.home, "current/scripts/update-finish.ts"),
    "utf8",
  );
  assert.doesNotMatch(installed, /finished-by/u);

  // The release changes the updater itself. A fix to the second half of an update
  // is only worth anything if it works in the release that carries it, so the code
  // that must run here is the one that has just been fetched.
  const sha = iva.publish((tree) => {
    const path = join(tree, "scripts/update-finish.ts");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        'const verbose = flags.includes("--verbose");',
        'const verbose = flags.includes("--verbose");\n' +
          '  writeFileSync(join(home, "finished-by"), name);',
      ),
    );
  });

  const output = update(iva);
  const name = `0.3.15-${sha.slice(0, 12)}`;
  assert.equal(active(iva), name, output);
  assert.equal(readFileSync(join(iva.home, "finished-by"), "utf8"), name);
});

test("an update follows the data directory the .env names, wherever it is", (t) => {
  const iva = world(t);
  // A data directory outside the installation, spelled absolutely - what setup
  // accepts and `iva config` writes. Everything the update owns has to follow it.
  const data = join(iva.dir, "state");
  mkdirSync(join(data, "custom/agent/tools"), { recursive: true });
  writeFileSync(
    join(data, "custom/agent/tools/feature.mjs"),
    "export const feature = 'mine';\n",
  );
  appendFileSync(join(iva.home, ".env"), `ASSISTANT_DATA_DIR=${data}\n`);

  const output = update(iva);
  const name = String(active(iva));
  // The customization is in the version that runs, not silently left behind.
  assert.match(name, /\+[0-9a-f]{8}$/u, output);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/tools/feature.mjs"), "utf8"),
    "export const feature = 'mine';\n",
    output,
  );
  assert.equal(realpathSync(join(iva.home, "current/data")), data, output);
  // Both markers landed in that directory - and nothing was written beside it,
  // where a second, invisible copy of the installation's state would have grown.
  assert.match(readFileSync(join(data, "migrations.json"), "utf8"), /001-iva/u);
  assert.match(readFileSync(join(data, "active.json"), "utf8"), /0\.3\.15-/u);
  for (const marker of ["active.json", "migrations.json"])
    assert.equal(existsSync(join(iva.home, "data", marker)), false, output);
  assert.match(iva.iva(["update"]).stdout, /already up to date/u);

  // And the gate is one lock, held in the same directory: a live one there stops
  // an update, so two of them can never run past each other.
  const lock = join(data, "update.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  const busy = iva.iva(["update"]);
  assert.equal(busy.status, 1, busy.stdout);
  assert.match(busy.stdout, /already running/u);
});

test("a customization that does not build leaves the service on the stock build", (t) => {
  const iva = world(t);
  update(iva);

  mkdirSync(join(iva.home, "data/custom/agent/tools"), { recursive: true });
  writeFileSync(
    join(iva.home, "data/custom/agent/tools/feature.mjs"),
    "// BUILD_BREAK\n",
  );
  const sha = iva.publish();
  const output = update(iva);
  const name = String(active(iva));
  // The version keeps the name it was staged under, customization digest and all,
  // so a customization known to be broken here is tried once and not every update.
  assert.match(
    name,
    new RegExp(`^0\\.3\\.15-${sha.slice(0, 12)}\\+`, "u"),
    output,
  );
  assert.match(output, /stock build/u);
  // The user's file is untouched, and the version that runs does not contain it.
  assert.equal(
    readFileSync(join(iva.home, "data/custom/agent/tools/feature.mjs"), "utf8"),
    "// BUILD_BREAK\n",
  );
  assert.equal(
    existsSync(join(iva.home, "versions", name, "agent/tools/feature.mjs")),
    false,
  );
});

test("a customization that builds is part of the version that runs", (t) => {
  const iva = world(t);
  mkdirSync(join(iva.home, "data/custom/agent/tools"), { recursive: true });
  writeFileSync(
    join(iva.home, "data/custom/agent/tools/feature.mjs"),
    "export const feature = 'mine';\n",
  );
  const output = update(iva);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/tools/feature.mjs"), "utf8"),
    "export const feature = 'mine';\n",
    output,
  );
});

test("a customization reaches the service without waiting for a release", (t) => {
  const iva = world(t);
  update(iva);
  const stock = String(active(iva));
  const tool = join(iva.home, "data/custom/agent/tools/feature.mjs");
  mkdirSync(join(iva.home, "data/custom/agent/tools"), { recursive: true });

  // Nothing upstream changed: the user added a tool, which is the whole point of
  // data/custom and used to need a release from somebody else to take effect.
  writeFileSync(tool, "export const feature = 'mine';\n");
  const applied = update(iva);
  assert.notEqual(active(iva), stock, applied);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/tools/feature.mjs"), "utf8"),
    "export const feature = 'mine';\n",
    applied,
  );
  assert.match(iva.iva(["update"]).stdout, /already up to date/u);

  // And one the build accepts but the start refuses: the service comes up on the
  // stock tree instead, and the next release is not blocked behind the user's file.
  writeFileSync(tool, "// START_BREAK\n");
  const fallback = update(iva);
  assert.match(fallback, /stock build/u);
  assert.equal(
    existsSync(join(iva.home, "current/agent/tools/feature.mjs")),
    false,
    fallback,
  );
  assert.equal(readFileSync(tool, "utf8"), "// START_BREAK\n");
  const sha = iva.publish((tree) =>
    writeFileSync(
      join(tree, "scripts/feature.mjs"),
      "export const next = 1;\n",
    ),
  );
  const next = update(iva);
  assert.match(
    String(active(iva)),
    new RegExp(`^0\\.3\\.15-${sha.slice(0, 12)}`, "u"),
    next,
  );
});

test("a downgrade is an ordinary update", (t) => {
  const iva = world(t);
  update(iva);
  const first = String(active(iva));
  const sha = iva.publish((tree) =>
    writeFileSync(
      join(tree, "scripts/feature.mjs"),
      "export const feature = 2;\n",
    ),
  );
  update(iva);
  assert.equal(active(iva), `0.3.15-${sha.slice(0, 12)}`);

  iva.git(iva.dir, [
    "-C",
    join(iva.dir, "source"),
    "push",
    "-q",
    "--force",
    "origin",
    `${first.slice(-12)}:main`,
  ]);
  const output = update(iva);
  assert.equal(active(iva), first, output);
});

test("killing an update leaves the running version alone and the next run cleans up", async (t) => {
  const iva = world(t);
  update(iva);
  const healthy = String(active(iva));
  iva.publish((tree) =>
    writeFileSync(
      join(tree, "scripts/feature.mjs"),
      "export const feature = 2;\n",
    ),
  );

  const child = spawn(iva.shim, ["update"], {
    cwd: iva.dir,
    env: {
      PATH: `${iva.dir}/bin:${process.env.PATH ?? ""}`,
      HOME: iva.fakeHome,
      NO_COLOR: "1",
      TERM: "dumb",
      IVA_TEST_SYSTEMCTL: iva.systemctlLog,
      IVA_TEST_EVE: readFileSync(
        join(iva.home, "current/node_modules/eve/bin/eve.js"),
        "utf8",
      ),
      IVA_TEST_MODULES: join(iva.home, "current/node_modules"),
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("close", resolve));
  // Kill once the new version's directory exists: mid-flight, before any flip.
  const deadline = Date.now() + 30_000;
  const versions = join(iva.home, "versions");
  while (readdirSync(versions).length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(readdirSync(versions).length, 2, "the update never got started");
  child.kill("SIGKILL");
  await exited;

  assert.equal(active(iva), healthy, "the running version did not move");
  const output = update(iva);
  assert.match(output, /removed leftover/u);
  assert.notEqual(active(iva), healthy);
});

test("an update whose restart fails is finished by the next one", (t) => {
  const iva = world(t);
  const name = `0.3.15-${iva.git(iva.home, ["rev-parse", "HEAD"]).slice(0, 12)}`;

  // No user session on the box: systemctl restart fails, the way it does on a VPS
  // without lingering. The flip has already happened by then.
  const broken = iva.iva(["update"], { IVA_TEST_SYSTEMCTL_FAIL: "1" });
  const failure = `${broken.stdout}${broken.stderr}`;
  assert.equal(broken.status, 1, failure);
  assert.match(failure, /Couldn't complete the update/u);
  assert.match(failure, /restart iva\.service failed/u);
  assert.doesNotMatch(failure, /^\s+at .*:\d+:\d+/mu, "no raw stack trace");
  assert.equal(active(iva), name);
  // Nothing that follows the restart ran, so the old checkout is still intact.
  assert.ok(existsSync(join(iva.home, ".git")));
  assert.doesNotMatch(readFileSync(iva.shim, "utf8"), /current\/bin/u);

  // The user runs `iva update` again - still through their old shim - and it
  // finishes the move instead of claiming there is nothing to do.
  const output = update(iva);
  assert.equal(active(iva), name, output);
  assert.match(
    readFileSync(iva.shim, "utf8"),
    /\$IVA_ROOT\/current\/bin\/iva\.mjs/u,
  );
  assert.equal(existsSync(join(iva.home, ".git")), false);
  assert.match(
    readFileSync(iva.systemctlLog, "utf8"),
    /restart .*iva\.service/u,
  );
  assert.match(iva.iva(["update"]).stdout, /already up to date/u);
});

test("two updates at once let exactly one of them work", async (t) => {
  const iva = world(t);
  update(iva);
  iva.publish((tree) =>
    writeFileSync(
      join(tree, "scripts/feature.mjs"),
      "export const feature = 2;\n",
    ),
  );

  const outcomes = await Promise.all([
    iva.ivaAsync(["update"]),
    iva.ivaAsync(["update"]),
  ]);
  const report = outcomes.map((outcome) => outcome.output).join("\n---\n");
  assert.equal(
    outcomes.filter((outcome) => outcome.code === 0).length,
    1,
    report,
  );
  assert.ok(/already running/u.test(report), report);
  // The loser changed nothing: one built version, one flip.
  assert.equal(readdirSync(join(iva.home, "versions")).length, 2, report);
});

test("a broken current symlink is repaired instead of blocking the update", (t) => {
  const iva = world(t);
  update(iva);
  const healthy = String(active(iva));

  rmSync(join(iva.home, "current"), { force: true });
  assert.equal(active(iva), null);
  const output = update(iva);
  assert.equal(active(iva), healthy, output);
  assert.match(output, /already up to date/u);
});

test("a rollback is a symlink flip and a restart, with no build and no network", (t) => {
  const iva = world(t);
  update(iva);
  const first = String(active(iva));
  iva.publish((tree) =>
    writeFileSync(
      join(tree, "scripts/feature.mjs"),
      "export const feature = 2;\n",
    ),
  );
  update(iva);
  const second = String(active(iva));
  rmSync(iva.upstream, { recursive: true, force: true });

  const result = iva.iva(["rollback"]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(active(iva), first);
  assert.ok(
    existsSync(join(iva.home, "versions", second)),
    "nothing was deleted",
  );
  assert.match(result.stdout, new RegExp(`${second} → ${first}`, "u"));
  // Nothing pins a version, so the release just rolled back from is still what
  // the next update resolves to. Saying so is the difference between a rollback
  // and a mystery when it comes back.
  assert.match(
    result.stdout,
    /another `iva rollback`.*can bring that version back/u,
  );
  // And forward again: the pair is symmetric, so a bad rollback is not a trap.
  assert.equal(iva.iva(["rollback"]).status, 0);
  assert.equal(active(iva), second);
});

test("a rollback aims the older version's state back at the installation", (t) => {
  const iva = world(t);
  update(iva);
  const first = String(active(iva));
  iva.publish((tree) =>
    writeFileSync(
      join(tree, "scripts/feature.mjs"),
      "export const feature = 2;\n",
    ),
  );
  update(iva);

  // What a probe killed halfway through leaves on the version it was proving:
  // state links into a scratch directory the next sweep has already taken away.
  const dir = join(iva.home, "versions", first);
  for (const name of ["data", "vault", ".eve/.workflow-data"]) {
    rmSync(join(dir, name), { recursive: true, force: true });
    symlinkSync(join(iva.home, ".probe-gone", name), join(dir, name));
  }

  const result = iva.iva(["rollback"]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(active(iva), first);
  for (const [name, target] of [
    ["data", join(iva.home, "data")],
    ["vault", join(iva.home, "vault")],
    [".eve/.workflow-data", join(iva.home, ".eve/.workflow-data")],
  ])
    assert.equal(
      realpathSync(join(dir, name)),
      realpathSync(target),
      `${name} still points at scratch`,
    );
});

test("--force installs the running release again, beside the version that runs", (t) => {
  const iva = world(t);
  update(iva);
  const name = String(active(iva));
  const built = join(iva.home, "versions", name, ".output/built.json");

  // A version whose build output was lost: the commit is right, `current` is
  // right, and the service cannot come up. Nothing about the commit or
  // data/custom changed, so an ordinary update has nothing to offer.
  rmSync(built, { force: true });
  const noop = iva.iva(["update"]);
  assert.match(noop.stdout, /already up to date/u);
  assert.equal(existsSync(built), false);

  rmSync(iva.startsLog, { force: true });
  const forced = iva.iva(["update", "--force"]);
  assert.equal(forced.status, 0, `${forced.stdout}${forced.stderr}`);

  // A rebuild is an install like any other: its own directory, proved from that
  // directory before anything points at it, then the flip.
  const rebuilt = `${name}~2`;
  assert.equal(active(iva), rebuilt);
  assert.ok(
    existsSync(join(iva.home, "versions", rebuilt, ".output/built.json")),
    "the rebuild was built",
  );
  const starts = readFileSync(iva.startsLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { cwd: string; probe: string });
  assert.deepEqual(
    starts.map((start) => [start.cwd, start.probe]),
    [[join(iva.home, "versions", rebuilt), "1"]],
  );
  // The tree the service was running from was never installed into or built in:
  // it is as broken as it was, and it is still the way back.
  assert.equal(existsSync(built), false);
  assert.deepEqual(
    readdirSync(join(iva.home, "versions")).sort(),
    [name, rebuilt].sort(),
  );
  // The rebuild is the same release, so the next ordinary update has nothing to do.
  assert.match(iva.iva(["update"]).stdout, /already up to date/u);
});

test("the CLI reports the commit of the active version once there is no working tree", (t) => {
  const iva = world(t);
  const sha = iva.git(iva.home, ["rev-parse", "HEAD"]);
  update(iva);
  const version = iva.iva(["version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, new RegExp(`commit ${sha.slice(0, 12)}`, "u"));
});

test("a rollback with nothing to go back to changes nothing", (t) => {
  const iva = world(t);
  update(iva);
  const only = active(iva);
  const result = iva.iva(["rollback"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no previous version/u);
  assert.equal(active(iva), only);
});

test("the move to versions keeps the files git ignores inside the code tree", (t) => {
  const iva = world(t);
  // Two kinds of state that live inside the code tree and only git ignores:
  // the proxy's virtualenv, built by `iva userbot setup`, and a credential a
  // skill keeps beside itself. Neither is recoverable and neither is ours.
  const venv = join(iva.home, "services/telegram-userbot/.venv/bin/python");
  mkdirSync(dirname(venv), { recursive: true });
  writeFileSync(venv, "#!/bin/sh\nexit 0\n");
  const secret = join(iva.home, "agent/skills/bts/token.local");
  mkdirSync(dirname(secret), { recursive: true });
  writeFileSync(secret, "s3cret\n");

  const output = update(iva);
  assert.equal(readFileSync(venv, "utf8"), "#!/bin/sh\nexit 0\n", output);
  assert.equal(readFileSync(secret, "utf8"), "s3cret\n", output);
  // The tracked code beside them still goes: only the ignored files stayed.
  assert.equal(
    existsSync(join(iva.home, "services/telegram-userbot/requirements.lock")),
    false,
    output,
  );
  assert.equal(existsSync(join(iva.home, "scripts")), false, output);
  assert.equal(existsSync(join(iva.home, "bin")), false, output);
  // A name git would quote is still a name of ours, and still goes.
  assert.equal(
    existsSync(
      join(iva.home, "agent/skills/\u043f\u0440\u0438\u0432\u0435\u0442.md"),
    ),
    false,
    output,
  );
});

test("an update puts the userbot proxy on the version it installs", (t) => {
  const iva = world(t);
  const output = update(iva);
  // The unit is written against `current`, so the interpreter it execs has to
  // exist in the version that just became current - nothing else creates it.
  const unit = readFileSync(
    join(iva.fakeHome, ".config/systemd/user/iva-telegram-userbot.service"),
    "utf8",
  );
  const python = /^ExecStart=(\S+)/mu.exec(unit)?.[1] ?? "";
  assert.match(python, new RegExp(`^${iva.home}/current/`, "u"));
  assert.ok(existsSync(python), `${python} is missing\n${output}`);
  assert.ok(
    existsSync(
      join(
        iva.home,
        "versions",
        String(active(iva)),
        "services/telegram-userbot/.venv/bin/python",
      ),
    ),
    output,
  );
  // Built from the version's own lock file, and the proxy put on the new code.
  const uv = readFileSync(iva.uvLog, "utf8");
  assert.match(uv, /^venv --python 3\.12 \.venv$/mu);
  assert.match(uv, /^pip sync --python .*--require-hashes --strict/mu);
  assert.match(
    readFileSync(iva.systemctlLog, "utf8"),
    /restart iva-telegram-userbot\.service/u,
  );
});

test("an update whose userbot proxy cannot be rebuilt still installs the version", (t) => {
  const iva = world(t);
  update(iva);
  const first = active(iva);
  // The lock file of the new version is unreadable: `uv` is never reached, and
  // a broken integration must not hold back the release that carries its fix.
  const sha = iva.publish((tree) =>
    rmSync(join(tree, "services/telegram-userbot/requirements.lock")),
  );

  const output = update(iva);
  assert.equal(active(iva), `0.3.15-${sha.slice(0, 12)}`, output);
  assert.notEqual(active(iva), first);
  assert.match(output, /telegram userbot proxy did not come up/u);
});
