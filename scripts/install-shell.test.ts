import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Every stand-in records the call and succeeds: what the installer must be judged on is
 * which stages it decides to run, so the log is the artifact. `$0` names the tool, so one
 * script serves sudo, systemctl, loginctl, uv and the two globals npm "installs".
 */
const RECORDER = `#!/bin/sh
echo "$(basename "$0") $*" >> "$IVA_TEST_CALLS"
exit 0
`;

/**
 * npm as far as install.sh can tell: it records every call, writes the hidden lockfile the
 * way a real `npm ci` does, produces a .output the way a real build does, and drops the
 * global binaries where `npm prefix -g` says they go.
 */
const NPM = `#!/bin/sh
echo "npm $*" >> "$IVA_TEST_CALLS"
case "$1" in
  prefix)
    printf '%s\\n' "$IVA_TEST_NPM_PREFIX"
    ;;
  ci|install)
    mkdir -p node_modules/.bin
    cp package-lock.json node_modules/.package-lock.json
    ln -sf "$IVA_TEST_RECORDER" node_modules/.bin/patch-package
    ;;
  exec)
    case "$*" in
      *"eve build"*)
        # The build is where a weak VPS dies: the OOM killer takes it (137), and where the
        # test needs a run to still be alive, it waits here after saying so.
        if [ -n "$IVA_TEST_BUILD_EXIT" ]; then
          echo "Killed" >&2
          exit "$IVA_TEST_BUILD_EXIT"
        fi
        if [ -n "$IVA_TEST_BUILD_WAIT" ]; then
          : > "$IVA_TEST_BUILD_WAIT"
          sleep 10
        fi
        mkdir -p .output
        printf 'built' > .output/server.mjs
        ;;
    esac
    ;;
  i)
    tool=""
    case "$*" in
      *agent-browser*) tool=agent-browser ;;
      *googleworkspace*) tool=gws ;;
    esac
    if [ -n "$tool" ]; then
      mkdir -p "$IVA_TEST_NPM_PREFIX/bin"
      ln -sf "$IVA_TEST_RECORDER" "$IVA_TEST_NPM_PREFIX/bin/$tool"
    fi
    ;;
esac
exit 0
`;

/**
 * The iva CLI the installer delegates the units to, including the failure it is famous
 * for. It is also the only thing the test can ask about the installation while the run is
 * still going: on request it writes down where the copy of .env is at that moment, with
 * what permissions, and what the run has put in TMPDIR.
 */
const IVA_CLI = `import { appendFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (process.env.IVA_TEST_CALLS)
  appendFileSync(process.env.IVA_TEST_CALLS, \`iva \${args.join(" ")}\\n\`);
const entries = (dir) => {
  try {
    return readdirSync(dir).map((name) => ({
      name,
      mode: (statSync(join(dir, name)).mode & 0o777).toString(8),
    }));
  } catch {
    return [];
  }
};
if (process.env.IVA_TEST_SNAPSHOT && args[0] === "_install-units") {
  const backups = join(process.cwd(), "data/update-backups");
  let dirMode = "";
  try {
    dirMode = (statSync(backups).mode & 0o777).toString(8);
  } catch {}
  writeFileSync(
    process.env.IVA_TEST_SNAPSHOT,
    JSON.stringify({
      cwd: process.cwd(),
      backupsMode: dirMode,
      backups: entries(backups),
      tmp: entries(process.env.TMPDIR ?? "/tmp"),
    }),
  );
}
if (args[0] === "_activate-units" && process.env.IVA_TEST_UNITS_FAIL) {
  process.stderr.write("Failed to connect to bus: No such file or directory\\n");
  process.exit(1);
}
`;

type RunOptions = {
  readonly calls?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The installer to run, when it must be one sitting inside the installation. */
  readonly script?: string;
};

type World = {
  readonly dir: string;
  readonly install: string;
  readonly home: string;
  readonly tmp: string;
  run(options?: RunOptions): SpawnSyncReturns<string>;
  /**
   * The same run without blocking, so a signal can arrive while it is working - which is
   * the only way to see what a dropped SSH session does to an install.
   */
  runAsync(options?: RunOptions): {
    signal(name: NodeJS.Signals): void;
    done: Promise<{
      code: number | null;
      signal: string | null;
      output: string;
    }>;
  };
  git(...args: string[]): string;
  /** Everything the run called, in order. */
  calls(path?: string): string;
};

const IDENTITY = {
  GIT_AUTHOR_NAME: "iva",
  GIT_AUTHOR_EMAIL: "iva@example.invalid",
  GIT_COMMITTER_NAME: "iva",
  GIT_COMMITTER_EMAIL: "iva@example.invalid",
};

/**
 * The stand-ins are stateless — every path they touch comes from the environment — so one
 * copy serves every world. Written once because macOS verifies each newly created
 * executable the first time it runs, which is seconds per world otherwise.
 */
const TOOLS = realpathSync(mkdtempSync(join(tmpdir(), "iva-install-tools-")));
const RECORDER_PATH = join(TOOLS, "recorder");
writeFileSync(RECORDER_PATH, RECORDER);
chmodSync(RECORDER_PATH, 0o755);
for (const name of ["sudo", "systemctl", "loginctl", "uv"])
  symlinkSync(RECORDER_PATH, join(TOOLS, name));
writeFileSync(join(TOOLS, "npm"), NPM);
chmodSync(join(TOOLS, "npm"), 0o755);
after(() => rmSync(TOOLS, { recursive: true, force: true }));

/**
 * A whole installed Iva as the reported failure had it: a checkout at INSTALL_DIR with an
 * origin to fetch from, the installer running from somewhere else (which is what
 * `curl | bash` does), and a HOME of its own. install.sh itself is the real file.
 */
function createWorld(t: TestContext, options: { env?: boolean } = {}): World {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-install-shell-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const install = join(dir, "iva");
  const remote = join(dir, "remote.git");
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  const npmPrefix = join(dir, "npm-global");
  const defaultCalls = join(dir, "calls.log");

  for (const path of [home, tmp, npmPrefix])
    mkdirSync(path, { recursive: true });
  // The installer never sits next to a package.json here, so it takes the branch a piped
  // `curl | bash` takes: the checkout at INSTALL_DIR.
  cpSync(join(ROOT, "install.sh"), join(dir, "install.sh"));

  mkdirSync(join(install, "bin"), { recursive: true });
  mkdirSync(join(install, "scripts"), { recursive: true });
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { eve: "0.30.8" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(install, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "iva", version: "0.0.0" },
          "node_modules/eve": { version: "0.30.8" },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(install, "bin/iva.mjs"), IVA_CLI);
  writeFileSync(join(install, "scripts/init-vault.mjs"), "");
  writeFileSync(join(install, "README.md"), "# fixture\n");
  // A patched dependency, like the real installation has: the hook that applies it is
  // npm's, so skipping npm has to apply it instead.
  mkdirSync(join(install, "patches"), { recursive: true });
  writeFileSync(join(install, "patches/eve+0.30.8.patch"), "");
  // The shipped ignore rules, so what the installer leaves behind is judged by them.
  cpSync(join(ROOT, ".gitignore"), join(install, ".gitignore"));

  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: install,
      encoding: "utf8",
      env: { ...process.env, ...IDENTITY },
    }).trim();

  git("init", "--quiet", "--initial-branch=main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "fixture");
  execFileSync("git", ["clone", "--quiet", "--bare", install, remote]);
  git("remote", "add", "origin", remote);

  if (options.env !== false)
    writeFileSync(join(install, ".env"), "AGENT_LANGUAGE=en\nIVA_PORT=8723\n");

  const environment = (runOptions: RunOptions): Record<string, string> => ({
    ...IDENTITY,
    PATH: `${TOOLS}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`,
    HOME: home,
    TMPDIR: tmp,
    NO_COLOR: "1",
    TERM: "dumb",
    INSTALL_DIR: install,
    BRANCH: "main",
    REPO_URL: remote,
    IVA_TEST_CALLS: runOptions.calls ?? defaultCalls,
    IVA_TEST_NPM_PREFIX: npmPrefix,
    IVA_TEST_RECORDER: RECORDER_PATH,
    ...runOptions.env,
  });

  return {
    dir,
    install,
    home,
    tmp,
    git,
    calls: (path = defaultCalls) =>
      existsSync(path) ? readFileSync(path, "utf8") : "",
    run: (runOptions = {}) =>
      spawnSync(
        "bash",
        [runOptions.script ?? join(dir, "install.sh"), "--non-interactive"],
        {
          cwd: dir,
          encoding: "utf8",
          env: environment(runOptions),
        },
      ),
    runAsync: (runOptions = {}) => {
      const child = spawn(
        "bash",
        [runOptions.script ?? join(dir, "install.sh"), "--non-interactive"],
        { cwd: dir, env: environment(runOptions) },
      );
      let output = "";
      const collect = (chunk: unknown): void => {
        output += String(chunk);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      return {
        signal: (name) => {
          child.kill(name);
        },
        done: new Promise((resolve) =>
          child.on("close", (code, signal) =>
            resolve({ code, signal, output }),
          ),
        ),
      };
    },
  };
}

/** Temp files this run created; the install log is the one it means to leave. */
function leftovers(tmp: string): string[] {
  return readdirSync(tmp).filter((name) => !name.startsWith("iva-install-"));
}

function backups(install: string): string[] {
  const dir = join(install, "data/update-backups");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function outputBackups(install: string): string[] {
  return readdirSync(install).filter((name) =>
    name.startsWith(".output.iva-install-backup-"),
  );
}

void test("install.sh is valid bash", () => {
  execFileSync("bash", ["-n", join(ROOT, "install.sh")]);
});

void test("an exit before any work is done stays quiet and succeeds", () => {
  // --help is the earliest exit there is, and it runs the same exit handler every failure
  // runs: everything it touches has to exist by then.
  const help = spawnSync("bash", [join(ROOT, "install.sh"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
  });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--skip-setup/u);
});

void test("a stage killed mid-way fails the install and gives the old build back", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  // 137: what the OOM killer leaves on a 512MB VPS, the failure this installer exists for.
  const result = world.run({ env: { IVA_TEST_BUILD_EXIT: "137" } });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Installation complete/u);
  assert.match(result.stderr, /Install stopped during/u);
  // The previous build is back where it was, not deleted as if the install had worked.
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  // The units were never touched: the run stopped at the build.
  assert.doesNotMatch(world.calls(), /iva _install-units/u);
});

void test("a dropped connection rolls the install back like any other failure", async (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  const waiting = join(world.dir, "building");
  const run = world.runAsync({ env: { IVA_TEST_BUILD_WAIT: waiting } });
  // Hang up the moment the run is provably inside the build, past the point where it has
  // moved the old output aside and written down everything it has to put back.
  for (let waited = 0; !existsSync(waiting) && waited < 20000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(waiting), "the run never reached the build");
  run.signal("SIGHUP");
  const result = await run.done;

  assert.notEqual(result.code, 0);
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
});

void test("the copy of .env lives beside the installation, never in /tmp", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  const snapshot = join(world.dir, "snapshot.json");

  const result = world.run({ env: { IVA_TEST_SNAPSHOT: snapshot } });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  // Taken while the install was still running, so it is the live state, not the leftovers.
  const live = JSON.parse(readFileSync(snapshot, "utf8")) as {
    backupsMode: string;
    backups: { name: string; mode: string }[];
    tmp: { name: string; mode: string }[];
  };
  const envCopy = live.backups.filter((entry) => entry.name.startsWith(".env"));
  assert.equal(envCopy.length, 1, JSON.stringify(live.backups));
  assert.equal(envCopy[0].mode, "600");
  assert.equal(live.backupsMode, "700");
  // The only thing this run may leave in a world-readable directory is its log.
  assert.deepEqual(
    live.tmp.filter((entry) => !entry.name.startsWith("iva-install-")),
    [],
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
});

void test("a pending reboot stops a first install and only warns over a configured one", (t) => {
  const world = createWorld(t, { env: false });
  const flag = join(world.dir, "reboot-required");
  writeFileSync(flag, "");
  writeFileSync(`${flag}.pkgs`, "linux-headers-6.8.0-137\n");

  // Nothing is configured yet, and every package stage is still ahead: refuse.
  const fresh = world.run({ env: { IVA_REBOOT_FLAG: flag } });
  assert.notEqual(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stderr, /sudo reboot/u);
  assert.doesNotMatch(world.calls(), /npm ci/u);

  // Configured: unattended-upgrades raises this flag for any security update, and a re-run
  // that installs nothing must not be refused for days.
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\n",
  );
  const rerun = world.run({
    calls: join(world.dir, "rerun.log"),
    env: { IVA_REBOOT_FLAG: flag },
  });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.match(rerun.stdout, /reboot/iu);
  assert.match(
    world.calls(join(world.dir, "rerun.log")),
    /iva _activate-units/u,
  );
});

void test("an installation without git rebuilds instead of trusting the stamp", (t) => {
  const world = createWorld(t);
  // A tree unpacked from an archive: the installer sits inside it and there is no history
  // to compare against, so nothing can prove the output matches the code.
  cpSync(join(ROOT, "install.sh"), join(world.install, "install.sh"));
  rmSync(join(world.install, ".git"), { recursive: true, force: true });

  const script = join(world.install, "install.sh");
  const first = world.run({ calls: join(world.dir, "first.log"), script });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(world.calls(join(world.dir, "first.log")), /eve build/u);

  const second = world.run({ calls: join(world.dir, "second.log"), script });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(world.calls(join(world.dir, "second.log")), /eve build/u);
});

void test("patches with nothing to apply them mean a full install, not a reuse", (t) => {
  const world = createWorld(t);
  assert.equal(world.run().status, 0);

  // What `npm prune --production` leaves behind: the tree still matches the lockfile by
  // npm's own record, but the tool that puts the patches on top is gone.
  rmSync(join(world.install, "node_modules/.bin/patch-package"), {
    force: true,
  });

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(world.calls(join(world.dir, "second.log")), /^npm ci$/mu);
});

void test("a failure at the last stage restores the checkout and leaves nothing behind", (t) => {
  const world = createWorld(t);
  // What the user has: an edit of their own, a file of their own, and a build.
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  const result = world.run({ env: { IVA_TEST_UNITS_FAIL: "1" } });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Install stopped during/u);

  // Nothing of this run survives it: no copy of .env anywhere, no stash entry, no backup
  // ref, no half-moved build output.
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  assert.deepEqual(outputBackups(world.install), []);

  // And everything of the user's survives it.
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.equal(
    readFileSync(join(world.install, ".env"), "utf8"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\n",
  );
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.equal(existsSync(join(world.install, ".output/server.mjs")), false);

  // The ignore rules keep a backup that somehow survives out of the next stash.
  mkdirSync(join(world.install, ".output.iva-install-backup-999"), {
    recursive: true,
  });
  writeFileSync(
    join(world.install, ".output.iva-install-backup-999/server.mjs"),
    "old\n",
  );
  assert.doesNotMatch(
    world.git("status", "--porcelain=v1", "--untracked-files=all"),
    /iva-install-backup/u,
  );
});

void test("a re-run over a finished install skips the stages that are already done", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");

  const first = world.run({ calls: join(world.dir, "first.log") });
  assert.equal(first.status, 0, first.stdout + first.stderr);

  const firstCalls = world.calls(join(world.dir, "first.log"));
  assert.match(firstCalls, /^npm ci$/mu);
  assert.match(firstCalls, /^npm i -g agent-browser$/mu);
  assert.match(firstCalls, /^npm i -g @googleworkspace\/cli@latest$/mu);
  assert.match(firstCalls, /^npm exec -- eve build$/mu);
  // A finished install keeps nothing either.
  assert.deepEqual(leftovers(world.tmp), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);

  const secondCalls = world.calls(join(world.dir, "second.log"));
  assert.doesNotMatch(secondCalls, /^npm ci$/mu);
  assert.doesNotMatch(secondCalls, /^npm install$/mu);
  assert.doesNotMatch(secondCalls, /^npm i -g /mu);
  assert.doesNotMatch(secondCalls, /eve build/u);
  assert.doesNotMatch(secondCalls, /agent-browser install/u);
  // Skipped, not forgotten: the dependencies are still checked against the lockfile and
  // the patches re-applied, and the units are still written and enabled.
  assert.match(secondCalls, /^patch-package\s*$/mu);
  assert.match(secondCalls, /^iva _install-units$/mu);
  assert.match(secondCalls, /^iva _activate-units$/mu);

  // The user's own state is still theirs after two runs.
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.equal(
    readFileSync(join(world.install, ".output/server.mjs"), "utf8"),
    "built",
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
});

void test("a changed .env rebuilds instead of reusing the output", (t) => {
  const world = createWorld(t);
  assert.equal(world.run().status, 0);
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8724\n",
  );
  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(world.calls(join(world.dir, "second.log")), /eve build/u);
});

void test("a first install into an empty directory still runs every stage", (t) => {
  const world = createWorld(t);
  const fresh = join(world.dir, "fresh");

  const result = world.run({ env: { INSTALL_DIR: fresh } });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  for (const stage of [
    /^npm ci$/mu,
    /^npm i -g agent-browser$/mu,
    /^agent-browser install --with-deps$/mu,
    /^npm i -g @googleworkspace\/cli@latest$/mu,
    /^npm exec -- eve build$/mu,
  ])
    assert.match(calls, stage);
  assert.equal(existsSync(join(fresh, ".output/server.mjs")), true);
  // Nothing was preserved, so nothing had to be cleaned up either.
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(backups(fresh), []);
  assert.equal(
    execFileSync("git", ["stash", "list"], { cwd: fresh, encoding: "utf8" }),
    "",
  );
});

void test("the deferred wizard ends with enabled units and lingering, in that order", (t) => {
  const world = createWorld(t, { env: false });

  const first = world.run({ calls: join(world.dir, "first.log") });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const firstCalls = world.calls(join(world.dir, "first.log"));
  assert.doesNotMatch(firstCalls, /iva _install-units/u);
  // Both places that tell the user what to do next name the same two commands: the
  // wizard, then the installer - never `iva restart`, which leaves the units disabled.
  const advice = (first.stdout + first.stderr).match(
    /npm run setup[\s\S]*?install\.sh/gu,
  );
  assert.equal(advice?.length, 2, first.stdout + first.stderr);
  assert.doesNotMatch(first.stdout, /iva restart/u);

  // What `npm run setup` leaves behind.
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\n",
  );

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const secondCalls = world.calls(join(world.dir, "second.log"));
  const linger = secondCalls.indexOf("loginctl enable-linger");
  const activate = secondCalls.indexOf("iva _activate-units");
  assert.ok(linger >= 0, `lingering was never enabled:\n${secondCalls}`);
  assert.match(secondCalls, /^iva _install-units$/mu);
  assert.ok(
    activate > linger,
    `the units were activated before lingering:\n${secondCalls}`,
  );
});

void test("a versioned install is refused instead of cloned into", (t) => {
  const world = createWorld(t);
  const versioned = join(world.dir, "v2");
  mkdirSync(join(versioned, "versions/0.3.20-0123456789ab"), {
    recursive: true,
  });
  const result = world.run({ env: { INSTALL_DIR: versioned } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /iva update/u);
  assert.match(result.stderr, /iva rollback/u);
  assert.equal(existsSync(join(versioned, ".git")), false);
});
