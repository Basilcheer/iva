/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtureProbe,
  fixtureRunner,
} from "../fixtures/version-update-harness.ts";
import { createVersionStore, layoutFor } from "./version-store.ts";
import { runVersionUpdate, type UpdateOutcome } from "./version-update.ts";

const HARNESS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/version-update-harness.ts",
);

/**
 * A migration that records that it ran - and, in the interruption harness, hangs
 * before doing so, which is the only moment where a killed update has already
 * flipped the symlink.
 */
const migration = (
  id: string,
) => `import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default async function up(context) {
  if (process.env.IVA_TEST_STALL === "migrate") {
    writeFileSync(process.env.IVA_TEST_MARKER, "migrate");
    await new Promise(() => {});
  }
  appendFileSync(join(context.dataDir, "migrated.log"), "${id}\\n");
}
`;

type World = {
  home: string;
  repo: string;
  git(...args: string[]): string;
  /** Commit the current repo state and report it as the next release. */
  release(version: string): { sha: string; version: string };
  target: { sha: string; version: string };
  update(
    overrides?: Partial<Parameters<typeof runVersionUpdate>[0]>,
  ): Promise<UpdateOutcome>;
  notices: string[];
  restarts: string[];
};

function world(t: { after(fn: () => void): void }): World {
  const home = mkdtempSync(join(tmpdir(), "iva-update-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  mkdirSync(join(repo, "scripts/migrations"), { recursive: true });
  mkdirSync(join(repo, "agent"), { recursive: true });
  writeFileSync(join(repo, "agent/agent.ts"), "export const agent = 1;\n");
  writeFileSync(join(repo, "scripts/migrations/001-note.ts"), migration("001"));

  const state: World = {
    home,
    repo,
    git,
    target: { sha: "", version: "" },
    notices: [],
    restarts: [],
    release(version) {
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "iva", version }),
      );
      git("add", "-A");
      git("commit", "-m", `release ${version}`);
      state.target = { sha: git("rev-parse", "HEAD"), version };
      return state.target;
    },
    update: (overrides = {}) =>
      runVersionUpdate({
        home,
        resolveTarget: () => Promise.resolve(state.target),
        run: fixtureRunner(),
        probe: fixtureProbe(),
        notify: (message) => state.notices.push(message),
        restart: (dir) => {
          state.restarts.push(dir);
          return Promise.resolve();
        },
        ...overrides,
      }),
  };
  state.release("0.3.14");
  return state;
}

function customFile(home: string, path: string, body: string): void {
  const target = join(layoutFor(home).data, "custom", path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

type Updated = Extract<UpdateOutcome, { status: "updated" }>;

/** Narrow to a successful update, failing the test with the real status otherwise. */
function updated(outcome: UpdateOutcome): Updated {
  assert.equal(outcome.status, "updated", JSON.stringify(outcome));
  return outcome;
}

/** Run the harness until it stalls at `step`, then SIGKILL it there. */
async function killAt(
  home: string,
  step: string,
  target: unknown,
): Promise<void> {
  const marker = join(home, `killed-at-${step}`);
  const targetFile = join(home, "target.json");
  writeFileSync(targetFile, JSON.stringify(target));
  const child = spawn(process.execPath, [HARNESS], {
    env: {
      ...process.env,
      IVA_TEST_HOME: home,
      IVA_TEST_STALL: step,
      IVA_TEST_MARKER: marker,
      IVA_TEST_TARGET: targetFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("close", resolve));
  let output = "";
  const collect = (chunk: unknown) => {
    output += String(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const deadline = Date.now() + 20_000;
  while (!existsSync(marker) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(existsSync(marker), `the harness never reached ${step}: ${output}`);
  child.kill("SIGKILL");
  await exited;
}

test("the new version's updater runs before there is a node_modules to run with", () => {
  // It is started in a version directory that has just been unpacked, so the
  // whole graph it reaches on the way to `npm ci` has to be built-ins and files
  // from the tree itself. One import of a package is a crash with no update.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const seen = new Set<string>();
  const queue = [join(root, "update-finish.ts")];
  const foreign: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)[^"]*?from\s*"([^"]+)"/gmu),
      ...source.matchAll(/^\s*import\s+"([^"]+)"/gmu),
      ...source.matchAll(/\bimport\("([^"]+)"\)/gu),
    ];
    for (const [, specifier] of specifiers) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        foreign.push(`${relative(root, file)} -> ${specifier}`);
        continue;
      }
      queue.push(join(dirname(file), specifier));
    }
  }
  assert.deepEqual(foreign, []);
  assert.ok(seen.size > 5, "the import graph was not walked");
});

test("a first update builds a version, proves it starts and activates it", async (t) => {
  const iva = world(t);

  const outcome = updated(await iva.update());
  assert.deepEqual(outcome, {
    status: "updated",
    version: `0.3.14-${iva.target.sha.slice(0, 12)}`,
    previous: null,
    custom: "none",
    migrations: ["001-note"],
    removed: [],
  });

  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), outcome.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 1;\n",
  );
  // The restart targets `current`, never the version directory a later flip replaces.
  assert.deepEqual(iva.restarts, [layoutFor(iva.home).current]);
  assert.equal(
    readFileSync(join(layoutFor(iva.home).data, "migrated.log"), "utf8"),
    "001\n",
  );
});

test("re-running an update with nothing new changes nothing and re-runs no migration", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());

  const again = await iva.update();
  assert.deepEqual(again, { status: "current", version: first.version });
  assert.equal(
    readFileSync(join(layoutFor(iva.home).data, "migrated.log"), "utf8"),
    "001\n",
  );
  assert.deepEqual(iva.restarts.length, 1);
});

test("a second release is built beside the running one and both survive for rollback", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");

  const second = updated(await iva.update());
  assert.equal(second.previous, first.version);
  const store = createVersionStore(iva.home);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 2;\n",
  );

  // Rollback is a symlink flip: no git, no rebuild, one restart.
  store.activate(first.version);
  assert.equal(store.currentName(), first.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 1;\n",
  );
});

test("a version that does not start is discarded and the running one stays live", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "UNHEALTHY"), "the new build crash-loops\n");
  const broken = iva.release("0.3.15");

  const outcome = await iva.update();
  assert.equal(outcome.status, "unhealthy");
  assert.match(outcome.status === "unhealthy" ? outcome.log : "", /boom/);

  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.equal(
    existsSync(
      join(store.layout.versions, `0.3.15-${broken.sha.slice(0, 12)}`),
    ),
    false,
  );
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);
  assert.match(iva.notices.join("\n"), /did not start/);
  assert.equal(iva.restarts.length, 1);
});

test("a customization that builds is layered into the new version", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");

  const outcome = updated(await iva.update());
  assert.equal(outcome.custom, "applied");
  assert.equal(
    readFileSync(join(iva.home, "current/agent/connections/mine.ts"), "utf8"),
    "export const mine = 1;\n",
  );
  assert.deepEqual(iva.notices, []);
});

test("the custom layer's own bookkeeping is not mistaken for the user's code", async (t) => {
  const iva = world(t);
  const data = layoutFor(iva.home).data;
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  // What PR #169 keeps next to the authored files, plus the shape that used to
  // reach the running installation: `data/` in a version is a link to this one.
  customFile(iva.home, "manifest.json", '{"schema":"iva-custom/v1"}\n');
  customFile(iva.home, "bases/abc", "old\n");
  customFile(iva.home, "data/planted.txt", "planted\n");
  const logged: string[] = [];

  const outcome = updated(await iva.update({ log: (m) => logged.push(m) }));
  assert.equal(outcome.custom, "applied");
  assert.ok(logged.includes("applied 1 customized file(s)"), logged.join("\n"));
  for (const path of ["manifest.json", "bases/abc"])
    assert.equal(existsSync(join(iva.home, "current", path)), false, path);
  assert.equal(existsSync(join(data, "planted.txt")), false);
});

test("a customization added after a release is a version of its own", async (t) => {
  const iva = world(t);
  const stock = updated(await iva.update());
  assert.equal(stock.custom, "none");

  // No new commit and no --force: the only thing that changed is the user's file.
  // Without an identity of its own it would resolve to the version already running
  // and never reach the service.
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  const applied = updated(await iva.update());
  assert.equal(applied.custom, "applied");
  assert.equal(applied.previous, stock.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/connections/mine.ts"), "utf8"),
    "export const mine = 1;\n",
  );
  // The same tree twice is not a rebuild.
  assert.deepEqual(await iva.update(), {
    status: "current",
    version: applied.version,
  });

  // An edit to the same file is another version again.
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 2;\n");
  const edited = updated(await iva.update());
  assert.notEqual(edited.version, applied.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/connections/mine.ts"), "utf8"),
    "export const mine = 2;\n",
  );
});

test("removing a customization goes back to the stock version already on disk", async (t) => {
  const iva = world(t);
  const stock = updated(await iva.update());
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  assert.notEqual(updated(await iva.update()).version, stock.version);

  rmSync(join(layoutFor(iva.home).data, "custom/agent/connections/mine.ts"), {
    force: true,
  });
  let builds = 0;
  const back = updated(
    await iva.update({
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
    }),
  );
  assert.equal(back.version, stock.version);
  assert.equal(back.custom, "none");
  assert.equal(builds, 0, "the stock version was still on disk");
  assert.equal(
    existsSync(join(iva.home, "current/agent/connections/mine.ts")),
    false,
  );
});

test("a failed probe never removes a finished version the installation can go back to", async (t) => {
  const iva = world(t);
  const stock = updated(await iva.update());
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  const customized = updated(await iva.update());

  // Taking the customization back out resolves to the stock version still on
  // disk. It is finished, it ran before, and it is the one thing a rollback has
  // to go back to - so a probe that fails against it says the probe went wrong,
  // not that the version may be deleted.
  rmSync(join(layoutFor(iva.home).data, "custom/agent/connections/mine.ts"), {
    force: true,
  });
  const outcome = await iva.update({
    probe: () => Promise.resolve({ ok: false, log: "boom" }),
  });

  assert.equal(outcome.status, "unhealthy");
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), customized.version);
  assert.deepEqual(
    readdirSync(store.layout.versions).sort(),
    [customized.version, stock.version].sort(),
  );
  assert.equal(store.previousName(), stock.version);
  // And it is still a version, not a directory left behind: it activates.
  store.activate(stock.version);
  assert.equal(store.currentName(), stock.version);
});

test("a customization that builds but does not start leaves the service on the stock build", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");

  // The build accepts it and the start refuses it: the shape of every custom-layer
  // incident, because the service compiles the authored sources again on start.
  const outcome = updated(
    await iva.update({
      probe: (dir, port) =>
        existsSync(join(dir, "agent/connections/mine.ts"))
          ? Promise.resolve({
              ok: false,
              log: "Cannot find module '../scripts/lib/provider.ts'",
            })
          : fixtureProbe()(dir, port),
    }),
  );

  assert.equal(outcome.custom, "stock");
  assert.equal(outcome.previous, first.version);
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), outcome.version);
  assert.equal(
    existsSync(join(iva.home, "current/agent/connections/mine.ts")),
    false,
  );
  assert.match(iva.notices.join("\n"), /does not start[\s\S]*stock build/u);
  // The file is still the user's, and the version that failed with it is not
  // rebuilt on every update until they change it.
  assert.equal(
    readFileSync(
      join(layoutFor(iva.home).data, "custom/agent/connections/mine.ts"),
      "utf8",
    ),
    "export const mine = 1;\n",
  );
  assert.deepEqual(await iva.update(), {
    status: "current",
    version: outcome.version,
  });
});

test("a customization that does not build never keeps the service down", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/connections/mine.ts", "BREAK this build\n");

  const outcome = updated(await iva.update());
  assert.equal(outcome.custom, "stock");
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), outcome.version);
  // The stock tree runs; the user's file is untouched where they wrote it.
  assert.equal(
    existsSync(join(iva.home, "current/agent/connections/mine.ts")),
    false,
  );
  assert.equal(
    readFileSync(
      join(layoutFor(iva.home).data, "custom/agent/connections/mine.ts"),
      "utf8",
    ),
    "BREAK this build\n",
  );
  assert.match(iva.notices.join("\n"), /does not build|stock build/);
  assert.equal(iva.restarts.length, 1);
});

test("an update with no network changes nothing and leaves no half-built version", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());

  await assert.rejects(
    iva.update({
      resolveTarget: () => Promise.reject(new Error("could not resolve host")),
    }),
    /could not resolve host/,
  );
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);
});

test("a build failure keeps the running version and removes the candidate", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "BREAK\n");
  iva.release("0.3.15");

  await assert.rejects(iva.update(), /build failed/);
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);
});

test("a build that fills the disk gives the space back and says what happened", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  iva.release("0.3.15");

  // A small VPS runs out of room mid-build. The half-written version is the one
  // thing on the box that is safe to delete, and the reason has to reach the user
  // or they will just run the update again into the same wall.
  await assert.rejects(
    iva.update({
      run: (command, args, cwd) =>
        args[1] === "build"
          ? Promise.resolve({
              code: 1,
              output:
                "ENOSPC: no space left on device, write '.output/server.mjs'",
            })
          : fixtureRunner()(command, args, cwd),
    }),
    /ENOSPC/,
  );
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);

  // With room again, the same update goes through - nothing was left claiming it.
  assert.equal(updated(await iva.update()).previous, first.version);
});

test("a second update refuses to run while the first one holds the lock", async (t) => {
  const iva = world(t);
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const slow = iva.update({
    run: fixtureRunner(async (step) => {
      if (step === "build") await held;
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(await iva.update(), { status: "busy" });
  release();
  assert.equal((await slow).status, "updated");
});

test("an update killed while building is cleaned up by the next run", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const store = createVersionStore(iva.home);

  for (const step of ["install", "build", "probe"]) {
    await killAt(iva.home, step, iva.target);
    // The running version is untouched and still the one the link points at.
    assert.equal(store.currentName(), first.version, `after kill at ${step}`);
    assert.equal(
      readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
      "export const agent = 1;\n",
    );
    // The dead update left a claimed directory and a lock; neither blocks the retry.
    assert.ok(
      existsSync(
        join(store.layout.versions, `0.3.15-${iva.target.sha.slice(0, 12)}`),
      ),
      `expected leftovers after kill at ${step}`,
    );
  }

  const outcome = updated(await iva.update());
  assert.equal(store.currentName(), outcome.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 2;\n",
  );
  assert.deepEqual(
    readdirSync(store.layout.versions).sort(),
    [first.version, outcome.version].sort(),
  );
});

test("an update killed after the flip is finished by the next run", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  writeFileSync(
    join(iva.repo, "scripts/migrations/002-note.ts"),
    migration("002"),
  );
  iva.release("0.3.15");
  const store = createVersionStore(iva.home);
  const { current, data } = layoutFor(iva.home);
  const name = `0.3.15-${iva.target.sha.slice(0, 12)}`;
  const log = (): string => readFileSync(join(data, "migrated.log"), "utf8");

  // Killed while migrating: `current` already names the new version, and nothing
  // that comes after the flip has happened.
  await killAt(iva.home, "migrate", iva.target);
  assert.equal(store.currentName(), name);
  assert.equal(store.settled(), first.version, "the move is not finished");
  assert.equal(log(), "001\n");

  // Killed again, at the restart, with the migration now applied.
  await killAt(iva.home, "restart", iva.target);
  assert.equal(store.settled(), first.version);
  assert.equal(log(), "001\n002\n");
  assert.equal(existsSync(join(iva.home, "adopted")), false);

  let builds = 0;
  const outcome = updated(
    await iva.update({
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
      adopt: () => writeFileSync(join(iva.home, "adopted"), ""),
    }),
  );
  assert.equal(outcome.version, name);
  assert.equal(builds, 0, "the version that already runs is not rebuilt");
  assert.equal(log(), "001\n002\n", "an applied migration is not replayed");
  assert.ok(existsSync(join(iva.home, "adopted")));
  assert.deepEqual(iva.restarts, [current, current]);
  assert.equal(store.settled(), name);
  // Only now is the update over.
  assert.deepEqual(await iva.update(), { status: "current", version: name });
});

test("a restart that fails leaves an update the next run can finish", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const store = createVersionStore(iva.home);
  const name = `0.3.15-${iva.target.sha.slice(0, 12)}`;

  await assert.rejects(
    iva.update({
      restart: () => Promise.reject(new Error("Failed to connect to bus")),
    }),
    /Failed to connect to bus/,
  );
  assert.equal(store.currentName(), name);
  assert.equal(store.settled(), first.version);

  let builds = 0;
  const outcome = updated(
    await iva.update({
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
    }),
  );
  assert.equal(outcome.version, name);
  assert.equal(builds, 0);
  assert.equal(store.settled(), name);
  assert.deepEqual(iva.restarts, [
    layoutFor(iva.home).current,
    layoutFor(iva.home).current,
  ]);
});

test("a probe port taken by somebody else is retried, not held against the version", async (t) => {
  const iva = world(t);
  let attempts = 0;
  const outcome = updated(
    await iva.update({
      probe: (_dir, port) => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? {
                ok: false,
                log: `Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
              }
            : { ok: true, log: "" },
        );
      },
    }),
  );
  assert.equal(attempts, 2);
  assert.equal(createVersionStore(iva.home).currentName(), outcome.version);
});

test("a version prepared but never activated is reused instead of rebuilt", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  const next = iva.release("0.3.15");
  const store = createVersionStore(iva.home);

  // Exactly the state a kill between "finished" and "activated" leaves behind.
  const name = `0.3.15-${next.sha.slice(0, 12)}`;
  const dir = store.stage(name);
  await store.materialize({ sha: next.sha, dir });
  store.linkState(dir);
  await fixtureRunner()("npm", ["run", "build"], dir);
  store.complete(name);
  assert.equal(store.currentName(), first.version);

  let builds = 0;
  updated(
    await iva.update({
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
    }),
  );
  assert.equal(store.currentName(), name);
  assert.equal(builds, 0, "a finished version must not be built twice");
});

test("a broken current link is healed before the update decides what to do", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  rmSync(join(iva.home, "current"), { force: true });

  const outcome = await iva.update();
  assert.deepEqual(outcome, { status: "current", version: first.version });
  assert.equal(createVersionStore(iva.home).currentName(), first.version);
});

test("old versions are collected while the running one and its rollback stay", async (t) => {
  const iva = world(t);
  const releases: string[] = [];
  for (const version of ["0.3.15", "0.3.16", "0.3.17"]) {
    writeFileSync(
      join(iva.repo, "agent/agent.ts"),
      `export const agent = "${version}";\n`,
    );
    iva.release(version);
    releases.push(updated(await iva.update()).version);
  }

  const store = createVersionStore(iva.home);
  const kept = readdirSync(store.layout.versions).sort();
  assert.equal(kept.length, 2);
  assert.ok(kept.includes(store.currentName()!));
  assert.ok(kept.includes(releases.at(-2)!));
});
