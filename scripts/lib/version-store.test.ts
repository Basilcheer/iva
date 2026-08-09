/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createVersionStore,
  layoutFor,
  parseVersionName,
  releaseOf,
  versionName,
} from "./version-store.ts";

function home(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-versions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Stage, fill and complete a version the way a successful update would. */
function install(
  store: ReturnType<typeof createVersionStore>,
  name: string,
  marker = name,
): string {
  const dir = store.stage(name);
  writeFileSync(join(dir, "marker.txt"), marker);
  store.complete(name);
  return dir;
}

function age(dir: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(dir, when, when);
}

test("version names carry the release, the commit and the customization", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(versionName("0.3.15", sha), "0.3.15-0123456789ab");
  assert.deepEqual(parseVersionName("0.3.15-0123456789ab"), {
    version: "0.3.15",
    sha: "0123456789ab",
    overlay: null,
    build: 1,
  });
  // The same commit with a customization is a different version, or a user's
  // edit would resolve to the version that is already running.
  assert.equal(
    versionName("0.3.15", sha, "beefcafe"),
    "0.3.15-0123456789ab+beefcafe",
  );
  assert.deepEqual(parseVersionName("0.3.15-0123456789ab+beefcafe"), {
    version: "0.3.15",
    sha: "0123456789ab",
    overlay: "beefcafe",
    build: 1,
  });
  // A rebuild of the same code is another directory, not another release: it
  // carries a build number, and `releaseOf` is what sees through it.
  assert.equal(
    versionName("0.3.15", sha, "beefcafe", 2),
    "0.3.15-0123456789ab+beefcafe~2",
  );
  assert.equal(parseVersionName("0.3.15-0123456789ab~3")?.build, 3);
  assert.equal(
    releaseOf("0.3.15-0123456789ab+beefcafe~2"),
    "0.3.15-0123456789ab+beefcafe",
  );
  assert.equal(releaseOf("0.3.15-0123456789ab"), "0.3.15-0123456789ab");
  assert.equal(parseVersionName("0.3.15-0123456789ab~"), null);
  assert.equal(parseVersionName("0.3.15-0123456789ab/../etc"), null);
  assert.equal(parseVersionName("0.3.15-0123456789ab+"), null);
  assert.equal(parseVersionName("0.3.15-0123456789ab+zzzzzzzz"), null);
  assert.equal(parseVersionName(".incomplete"), null);
  assert.equal(parseVersionName("node_modules"), null);
  assert.equal(parseVersionName("0.3.15-XYZ"), null);
});

test("layout keeps state outside the versions tree", (t) => {
  const root = home(t);
  const layout = layoutFor(root);
  assert.equal(layout.versions, join(root, "versions"));
  assert.equal(layout.current, join(root, "current"));
  assert.equal(layout.data, join(root, "data"));
  assert.equal(layout.vault, join(root, "vault"));
  assert.equal(layout.env, join(root, ".env"));
  for (const path of [layout.data, layout.vault, layout.env])
    assert.equal(path.startsWith(join(root, "versions")), false);
});

test("an interrupted stage leaves the active version untouched and is swept later", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  // kill -9 in the middle of building the candidate: the directory exists, the sentinel stays.
  const staged = store.stage("0.3.15-bbbbbbbbbbbb");
  writeFileSync(join(staged, "half-built.txt"), "partial");

  assert.deepEqual(
    store.list().map((entry) => entry.name),
    ["0.3.14-aaaaaaaaaaaa"],
  );
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  assert.throws(() => store.activate("0.3.15-bbbbbbbbbbbb"), /incomplete/);

  assert.deepEqual(store.sweep(), ["0.3.15-bbbbbbbbbbbb"]);
  assert.equal(existsSync(staged), false);
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  assert.equal(
    readFileSync(join(store.layout.current, "marker.txt"), "utf8"),
    "0.3.14-aaaaaaaaaaaa",
  );
});

test("sweep keeps complete versions and the active one, and clears stale flip links", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  install(store, "0.3.15-bbbbbbbbbbbb");
  store.activate("0.3.15-bbbbbbbbbbbb");
  // kill -9 between creating the replacement link and renaming it over `current`.
  symlinkSync(
    join(root, "versions/0.3.14-aaaaaaaaaaaa"),
    join(root, ".current.iva-flip-1234"),
  );

  assert.deepEqual(store.sweep(), [".current.iva-flip-1234"]);
  assert.equal(existsSync(join(root, ".current.iva-flip-1234")), false);
  assert.deepEqual(
    store
      .list()
      .map((entry) => entry.name)
      .sort(),
    ["0.3.14-aaaaaaaaaaaa", "0.3.15-bbbbbbbbbbbb"],
  );
  assert.equal(store.currentName(), "0.3.15-bbbbbbbbbbbb");
});

test("activation is atomic, repeatable and reversible without git", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  install(store, "0.3.15-bbbbbbbbbbbb");

  store.activate("0.3.14-aaaaaaaaaaaa");
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.15-bbbbbbbbbbbb");
  store.activate("0.3.15-bbbbbbbbbbbb");
  assert.equal(store.currentName(), "0.3.15-bbbbbbbbbbbb");
  assert.equal(lstatSync(layoutFor(root).current).isSymbolicLink(), true);

  // Downgrade: the previous version is still on disk, so rollback is one flip.
  assert.equal(store.previousName(), "0.3.14-aaaaaaaaaaaa");
  store.activate(store.previousName()!);
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  assert.equal(
    readFileSync(join(root, "current/marker.txt"), "utf8"),
    "0.3.14-aaaaaaaaaaaa",
  );
  // No leftover flip links from three activations.
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".current")),
    [],
  );
});

test("a missing, dangling or foreign current link is healed onto the newest version", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  age(install(store, "0.3.14-aaaaaaaaaaaa"), 600);
  install(store, "0.3.15-bbbbbbbbbbbb");

  assert.equal(store.currentName(), null);
  assert.equal(store.heal(), "0.3.15-bbbbbbbbbbbb");

  // Dangling: the target was removed by hand.
  rmSync(layout.current, { force: true });
  symlinkSync(join(layout.versions, "0.3.99-cccccccccccc"), layout.current);
  assert.equal(store.currentName(), null);
  assert.equal(store.heal(), "0.3.15-bbbbbbbbbbbb");

  // Foreign: pointing outside the versions tree is not a valid installation.
  const foreign = join(root, "elsewhere");
  mkdirSync(foreign);
  rmSync(layout.current, { force: true });
  symlinkSync(foreign, layout.current);
  assert.equal(store.currentName(), null);
  assert.equal(store.heal(), "0.3.15-bbbbbbbbbbbb");

  // A real directory left where the link belongs is replaced, not merged into.
  rmSync(layout.current, { force: true });
  mkdirSync(layout.current);
  writeFileSync(join(layout.current, "junk"), "junk");
  store.activate("0.3.14-aaaaaaaaaaaa");
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  assert.equal(lstatSync(layout.current).isSymbolicLink(), true);

  // Nothing to heal onto: report it instead of guessing.
  rmSync(layout.current, { force: true });
  rmSync(layout.versions, { recursive: true, force: true });
  assert.equal(store.heal(), null);
});

test("healing goes back to the version the installation settled on", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  age(install(store, "0.3.14-aaaaaaaaaaaa"), 600);
  install(store, "0.3.15-bbbbbbbbbbbb");
  // A rollback: onto the older version, and said so.
  store.activate("0.3.14-aaaaaaaaaaaa");
  store.settle("0.3.14-aaaaaaaaaaaa");
  // The state links a rollback leaves are the installation's; a probe's are not.
  store.linkState(
    join(layout.versions, "0.3.14-aaaaaaaaaaaa"),
    join(root, "gone"),
  );
  rmSync(layout.current, { force: true });

  // Never the newest on disk: that is the version the rollback rejected.
  assert.equal(store.heal(), "0.3.14-aaaaaaaaaaaa");
  assert.equal(
    realpathSync(join(root, "current/data")),
    realpathSync(layout.data),
  );
});

test("two updates racing on the same version let exactly one stage it", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  store.stage("0.3.15-bbbbbbbbbbbb");
  assert.throws(() => store.stage("0.3.15-bbbbbbbbbbbb"), /already/);
  // Restaging the running version would delete the live installation.
  assert.throws(() => store.stage("0.3.14-aaaaaaaaaaaa"), /active/);
  assert.throws(() => store.stage("../escape"), /invalid version/);
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
});

test("a rebuild of the running release gets a directory the running one does not own", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  const rebuild = store.nextBuild("0.3.14-aaaaaaaaaaaa");
  assert.equal(rebuild, "0.3.14-aaaaaaaaaaaa~2");
  assert.equal(releaseOf(rebuild), "0.3.14-aaaaaaaaaaaa");
  // Staging it is legal precisely because it is not the directory that runs.
  store.stage(rebuild);
  assert.equal(store.nextBuild("0.3.14-aaaaaaaaaaaa"), "0.3.14-aaaaaaaaaaaa~3");
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  // A release with nothing on disk keeps its plain name.
  assert.equal(store.nextBuild("0.3.15-bbbbbbbbbbbb"), "0.3.15-bbbbbbbbbbbb");
  assert.throws(() => store.nextBuild("../escape"), /invalid version/);
});

test("a failure to write the staging directory leaves the installation untouched", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  // Stand-in for a full disk: the versions directory cannot be written into.
  const layout = layoutFor(root);
  chmodSync(layout.versions, 0o500);
  try {
    assert.throws(() => store.stage("0.3.15-bbbbbbbbbbbb"));
    assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
    assert.equal(
      existsSync(join(layout.versions, "0.3.15-bbbbbbbbbbbb")),
      false,
    );
  } finally {
    chmodSync(layout.versions, 0o700);
  }
});

test("garbage collection keeps the active version and the rollback target", (t) => {
  const store = createVersionStore(home(t));
  age(install(store, "0.3.11-111111111111"), 400);
  age(install(store, "0.3.12-222222222222"), 300);
  age(install(store, "0.3.13-333333333333"), 200);
  install(store, "0.3.14-444444444444");
  store.activate("0.3.13-333333333333");

  assert.deepEqual(store.gc(2), ["0.3.11-111111111111", "0.3.12-222222222222"]);
  assert.deepEqual(
    store
      .list()
      .map((entry) => entry.name)
      .sort(),
    ["0.3.13-333333333333", "0.3.14-444444444444"],
  );
  assert.equal(store.currentName(), "0.3.13-333333333333");
  // Idempotent: a second collection has nothing left to drop.
  assert.deepEqual(store.gc(2), []);
  // Even keep=1 never removes the active version.
  assert.deepEqual(store.gc(1), ["0.3.14-444444444444"]);
  assert.equal(store.currentName(), "0.3.13-333333333333");
});

test("materialize writes an exact commit tree without leaving git state behind", async (t) => {
  const root = home(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(
    join(repo, "package.json"),
    '{"name":"iva","version":"0.3.14"}',
  );
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  writeFileSync(join(repo, "scripts/lib/keep.ts"), "old\n");
  git("add", "-A");
  git("commit", "-m", "one");
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "scripts/lib/keep.ts"), "new\n");
  git("add", "-A");
  git("commit", "-m", "two");
  const second = git("rev-parse", "HEAD");

  const store = createVersionStore(root);
  const dir = store.stage(versionName("0.3.14", first));
  await store.materialize({ sha: first, dir });
  assert.equal(readFileSync(join(dir, "scripts/lib/keep.ts"), "utf8"), "old\n");
  assert.equal(existsSync(join(dir, ".git")), false);
  store.complete(versionName("0.3.14", first));

  const newer = store.stage(versionName("0.3.15", second));
  await store.materialize({ sha: second, dir: newer });
  assert.equal(
    readFileSync(join(newer, "scripts/lib/keep.ts"), "utf8"),
    "new\n",
  );

  await assert.rejects(
    store.materialize({ sha: "0".repeat(40), dir: newer }),
    /materialize/,
  );
});

test("state directories are shared into a version instead of copied", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  mkdirSync(layout.data, { recursive: true });
  mkdirSync(layout.vault, { recursive: true });
  writeFileSync(layout.env, "IVA_PORT=8723\n");
  writeFileSync(join(layout.data, "state.json"), "{}");

  const dir = store.stage("0.3.15-bbbbbbbbbbbb");
  store.linkState(dir);
  store.complete("0.3.15-bbbbbbbbbbbb");

  assert.equal(lstatSync(join(dir, "data")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(dir, "data")), realpathSync(layout.data));
  assert.equal(realpathSync(join(dir, "vault")), realpathSync(layout.vault));
  assert.equal(realpathSync(join(dir, ".env")), realpathSync(layout.env));
  // Re-linking an already linked version is a no-op, not an EEXIST failure.
  store.linkState(dir);
  assert.equal(readFileSync(join(dir, "data/state.json"), "utf8"), "{}");
});

test("the workflow store older installs kept is shared where it exists, never created", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const fresh = store.stage("0.3.15-bbbbbbbbbbbb");
  store.linkState(fresh);
  // A box installed after the move never had one, and an empty directory that
  // only means "this install is old" is not something to hand a new one.
  assert.equal(existsSync(join(root, ".workflow-data")), false);
  assert.equal(existsSync(join(fresh, ".workflow-data")), false);

  mkdirSync(join(root, ".workflow-data"), { recursive: true });
  writeFileSync(join(root, ".workflow-data/run.json"), '{"run":1}\n');
  const legacy = store.stage("0.3.16-cccccccccccc");
  store.linkState(legacy);
  assert.equal(
    readFileSync(join(legacy, ".workflow-data/run.json"), "utf8"),
    '{"run":1}\n',
  );
  // And a probe reaches scratch through it, not the store the service is using.
  const scratch = store.sandboxState("0.3.16-cccccccccccc");
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  writeFileSync(join(legacy, ".workflow-data/probe.json"), "{}");
  assert.equal(existsSync(join(scratch, ".workflow-data/probe.json")), true);
  assert.equal(existsSync(join(root, ".workflow-data/probe.json")), false);
});

test("a version being probed writes to scratch state, not the installation's", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  const name = "0.3.15-bbbbbbbbbbbb";
  const dir = store.stage(name);
  store.linkState(dir);
  writeFileSync(layout.env, "IVA_PORT=8723\n");
  mkdirSync(join(layout.data, "custom"), { recursive: true });
  writeFileSync(join(root, ".eve/.workflow-data/open-run.json"), "{}");

  const scratch = store.sandboxState(name);
  assert.equal(
    dirname(scratch),
    root,
    "scratch state belongs outside versions",
  );
  // What a started server writes goes through the links, and has to land in the
  // sandbox: a version that is only being proved is not the installation yet.
  writeFileSync(join(dir, "data/started.log"), "started\n");
  writeFileSync(join(dir, ".eve/.workflow-data/started.log"), "re-enqueued\n");
  assert.equal(existsSync(join(layout.data, "started.log")), false);
  assert.equal(
    existsSync(join(root, ".eve/.workflow-data/started.log")),
    false,
  );
  assert.equal(
    readFileSync(join(root, ".eve/.workflow-data/open-run.json"), "utf8"),
    "{}",
  );
  // The installation's own .env is read even by a probe - that is the point of it.
  assert.equal(realpathSync(join(dir, ".env")), realpathSync(layout.env));

  // Proved: the state links go back to the installation.
  store.linkState(dir);
  store.complete(name);
  assert.equal(realpathSync(join(dir, "data")), realpathSync(layout.data));
  assert.equal(
    realpathSync(join(dir, ".eve/.workflow-data")),
    realpathSync(join(root, ".eve/.workflow-data")),
  );
  assert.equal(existsSync(join(dir, ".iva-incomplete")), false);
});

test("re-proving a finished version leaves the version, not the version's grave", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const name = "0.3.15-bbbbbbbbbbbb";
  const dir = store.stage(name);
  store.linkState(dir);
  store.complete(name);
  // A finished version goes back to scratch state whenever it is proved again:
  // a downgrade onto it, or an interrupted run that built it but never flipped.
  const scratch = store.sandboxState(name);

  // Being checked is not being unfinished. A kill right here used to hand the
  // next sweep the very version the installation was going back to.
  assert.deepEqual(
    store.list().map((entry) => entry.name),
    [name],
  );
  assert.deepEqual(store.sweep(), [basename(scratch)]);
  assert.equal(existsSync(dir), true);
  assert.equal(existsSync(scratch), false);
});

test("activating a version aims its state at the installation, whatever it was probed on", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  const name = "0.3.15-bbbbbbbbbbbb";
  const dir = store.stage(name);
  store.complete(name);
  // Killed while proving this version - a downgrade, or one prepared and never
  // flipped: its state links are left aimed at a scratch directory that the next
  // sweep removes. Rolling back onto it must not start a service on those.
  const scratch = store.sandboxState(name);
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(layout.env, "IVA_PORT=8723\n");
  mkdirSync(layout.data, { recursive: true });
  writeFileSync(join(layout.data, "state.json"), "{}");

  store.activate(name);

  assert.equal(store.currentName(), name);
  assert.equal(realpathSync(join(dir, "data")), realpathSync(layout.data));
  assert.equal(realpathSync(join(dir, ".env")), realpathSync(layout.env));
  assert.equal(readFileSync(join(dir, "data/state.json"), "utf8"), "{}");
});

test("a version links .env before there is one, so a later write lands outside", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const dir = store.stage("0.3.15-bbbbbbbbbbbb");
  store.linkState(dir);

  assert.equal(existsSync(layoutFor(root).env), false);
  assert.equal(lstatSync(join(dir, ".env")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(dir, ".env")), layoutFor(root).env);
});

test("resetting a staged version clears it without giving up the claim", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  const dir = store.stage("0.3.15-bbbbbbbbbbbb");
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent/broken.ts"), "does not compile");
  store.linkState(dir);

  assert.equal(store.reset("0.3.15-bbbbbbbbbbbb"), dir);
  assert.deepEqual(readdirSync(dir), [".iva-incomplete"]);
  assert.deepEqual(
    store.list().map((entry) => entry.name),
    ["0.3.14-aaaaaaaaaaaa"],
  );
  // The shared state the version borrowed is untouched by the reset.
  assert.equal(existsSync(layoutFor(store.layout.home).data), true);

  // A finished version is never someone's scratch space.
  assert.throws(() => store.reset("0.3.14-aaaaaaaaaaaa"), /complete/);
  assert.equal(
    readFileSync(join(store.layout.current, "marker.txt"), "utf8"),
    "0.3.14-aaaaaaaaaaaa",
  );
});
