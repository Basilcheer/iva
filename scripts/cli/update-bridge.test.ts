/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

  const output = update(iva);
  const name = `0.3.15-${sha.slice(0, 12)}`;
  assert.equal(active(iva), name, output);

  const dir = join(iva.home, "versions", name);
  assert.ok(existsSync(join(dir, ".output/built.json")), "the version was built");
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
  assert.match(readFileSync(iva.shim, "utf8"), /\$IVA_ROOT\/current\/bin\/iva\.mjs/u);
  const unit = readFileSync(
    join(iva.fakeHome, ".config/systemd/user/iva.service"),
    "utf8",
  );
  assert.match(unit, new RegExp(`WorkingDirectory=${iva.home}/current$`, "mu"));
  assert.match(unit, new RegExp(`${iva.home}/current/node_modules/eve/bin/eve\\.js`, "u"));
  assert.match(readFileSync(iva.systemctlLog, "utf8"), /restart .*iva\.service/u);
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
    writeFileSync(join(tree, "scripts/feature.mjs"), "export const feature = 2;\n"),
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

  iva.publish((tree) =>
    writeFileSync(join(tree, "scripts/feature.mjs"), "// START_BREAK\n"),
  );
  const result = iva.iva(["update"]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /provider\.ts/u);
  assert.equal(active(iva), healthy);
  assert.deepEqual(readdirSync(join(iva.home, "versions")), [healthy]);
});

test("a customization that does not build leaves the service on the stock build", (t) => {
  const iva = world(t);
  update(iva);

  mkdirSync(join(iva.home, "data/custom/scripts"), { recursive: true });
  writeFileSync(
    join(iva.home, "data/custom/scripts/feature.mjs"),
    "// BUILD_BREAK\n",
  );
  const sha = iva.publish();
  const output = update(iva);
  const name = `0.3.15-${sha.slice(0, 12)}`;
  assert.equal(active(iva), name, output);
  assert.match(output, /stock build/u);
  // The user's file is untouched, and the version that runs does not contain it.
  assert.equal(
    readFileSync(join(iva.home, "data/custom/scripts/feature.mjs"), "utf8"),
    "// BUILD_BREAK\n",
  );
  assert.equal(
    existsSync(join(iva.home, "versions", name, "scripts/feature.mjs")),
    false,
  );
});

test("a customization that builds is part of the version that runs", (t) => {
  const iva = world(t);
  mkdirSync(join(iva.home, "data/custom/scripts"), { recursive: true });
  writeFileSync(
    join(iva.home, "data/custom/scripts/feature.mjs"),
    "export const feature = 'mine';\n",
  );
  const output = update(iva);
  assert.equal(
    readFileSync(join(iva.home, "current/scripts/feature.mjs"), "utf8"),
    "export const feature = 'mine';\n",
    output,
  );
});

test("a downgrade is an ordinary update", (t) => {
  const iva = world(t);
  update(iva);
  const first = String(active(iva));
  const sha = iva.publish((tree) =>
    writeFileSync(join(tree, "scripts/feature.mjs"), "export const feature = 2;\n"),
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
    writeFileSync(join(tree, "scripts/feature.mjs"), "export const feature = 2;\n"),
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

test("two updates at once let exactly one of them work", async (t) => {
  const iva = world(t);
  update(iva);
  iva.publish((tree) =>
    writeFileSync(join(tree, "scripts/feature.mjs"), "export const feature = 2;\n"),
  );

  const outcomes = await Promise.all([iva.ivaAsync(["update"]), iva.ivaAsync(["update"])]);
  const report = outcomes.map((outcome) => outcome.output).join("\n---\n");
  assert.equal(outcomes.filter((outcome) => outcome.code === 0).length, 1, report);
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
    writeFileSync(join(tree, "scripts/feature.mjs"), "export const feature = 2;\n"),
  );
  update(iva);
  const second = String(active(iva));
  rmSync(iva.upstream, { recursive: true, force: true });

  const result = iva.iva(["rollback"]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(active(iva), first);
  assert.ok(existsSync(join(iva.home, "versions", second)), "nothing was deleted");
  assert.match(result.stdout, new RegExp(`${second} → ${first}`, "u"));
  // And forward again: the pair is symmetric, so a bad rollback is not a trap.
  assert.equal(iva.iva(["rollback"]).status, 0);
  assert.equal(active(iva), second);
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
