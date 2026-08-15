/* eslint-disable @typescript-eslint/no-floating-promises -- Node registers top-level tests synchronously. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUpdateTransaction } from "./update-safety.ts";

type Fixture = {
  temp: string;
  remote: string;
  seed: string;
  local: string;
  data: string;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitHex(cwd: string, ...args: string[]): string {
  return Buffer.from(execFileSync("git", args, { cwd })).toString("hex");
}

function fixture(): Fixture {
  const temp = mkdtempSync(join(tmpdir(), "iva-recovery-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Iva Test");
  writeFileSync(
    join(seed, ".gitignore"),
    ".env\n.output\n/.iva-update/\nnode_modules\n",
  );
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  git(local, "config", "user.email", "test@example.com");
  git(local, "config", "user.name", "Iva Test");
  mkdirSync(data, { recursive: true });
  return { temp, remote, seed, local, data };
}

function transaction(fx: Fixture) {
  return createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
  });
}

function wrappedTransaction(fx: Fixture, body: string) {
  const bin = join(fx.temp, "wrapped-git");
  const wrapper = join(bin, "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(bin);
  writeFileSync(
    wrapper,
    "#!/bin/sh\n" +
      body.replaceAll("__REAL_GIT__", JSON.stringify(realGit)) +
      `\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
}

function rawState(local: string) {
  return {
    status: gitHex(
      local,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ),
    staged: gitHex(local, "diff", "--binary", "--cached"),
    tracked: readFileSync(join(local, "tracked.txt")).toString("hex"),
    untracked: readFileSync(join(local, "raw.bin")).toString("hex"),
  };
}

function prepareRawState(local: string) {
  writeFileSync(join(local, "tracked.txt"), "staged\n");
  git(local, "add", "tracked.txt");
  writeFileSync(join(local, "tracked.txt"), "unstaged\r\n");
  writeFileSync(join(local, "raw.bin"), Buffer.from([0, 65, 10, 255]));
  return rawState(local);
}

test("rollback restores raw bytes without clean, smudge or eol filters", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  git(fx.local, "config", "filter.lossy.clean", "LC_ALL=C tr A B");
  git(fx.local, "config", "filter.lossy.smudge", "cat");
  git(fx.local, "config", "filter.lossy.required", "true");
  writeFileSync(
    join(fx.local, ".gitattributes"),
    [
      "filtered.txt filter=lossy -text",
      "filtered.bin filter=lossy -text",
      "eol.txt text eol=crlf",
      "",
    ].join("\n"),
  );
  writeFileSync(join(fx.local, "filtered.txt"), "base\n");
  writeFileSync(join(fx.local, "filtered.bin"), Buffer.from([0, 1, 255]));
  writeFileSync(join(fx.local, "eol.txt"), "base\n");
  git(
    fx.local,
    "add",
    ".gitattributes",
    "filtered.txt",
    "filtered.bin",
    "eol.txt",
  );
  git(fx.local, "commit", "-m", "add filtered files");

  writeFileSync(join(fx.local, "filtered.txt"), "A-staged\n");
  git(fx.local, "add", "filtered.txt");
  writeFileSync(join(fx.local, "filtered.txt"), "A-unstaged\r\n");
  writeFileSync(join(fx.local, "filtered.bin"), Buffer.from([0, 65, 10, 255]));
  writeFileSync(join(fx.local, "eol.txt"), "raw-eol\r\n");
  const leadingPath = " leading\nname ";
  writeFileSync(join(fx.local, leadingPath), Buffer.from([32, 0, 10, 255]));
  const state = () => ({
    status: gitHex(
      fx.local,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ),
    staged: gitHex(fx.local, "diff", "--binary", "--cached"),
    filtered: readFileSync(join(fx.local, "filtered.txt")).toString("hex"),
    binary: readFileSync(join(fx.local, "filtered.bin")).toString("hex"),
    eol: readFileSync(join(fx.local, "eol.txt")).toString("hex"),
    leading: readFileSync(join(fx.local, leadingPath)).toString("hex"),
  });
  const before = state();
  const tx = transaction(fx);

  await tx.protect();
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  assert.equal(
    execFileSync("git", ["show", `${recoveryOid}:filtered.txt`], {
      cwd: fx.local,
    }).toString("hex"),
    before.filtered,
  );
  assert.equal(
    execFileSync("git", ["show", `${recoveryOid}:filtered.bin`], {
      cwd: fx.local,
    }).toString("hex"),
    before.binary,
  );

  await tx.rollback();

  assert.deepEqual(state(), before);
});

test("rollback restores assume-unchanged and skip-worktree flags with hidden bytes", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  writeFileSync(join(fx.local, "skip.txt"), "skip base\n");
  git(fx.local, "add", "skip.txt");
  git(fx.local, "commit", "-m", "add index flag fixture");
  git(fx.local, "update-index", "--assume-unchanged", "tracked.txt");
  git(fx.local, "update-index", "--skip-worktree", "skip.txt");
  writeFileSync(join(fx.local, "tracked.txt"), "assume hidden\n");
  writeFileSync(join(fx.local, "skip.txt"), "skip hidden\n");
  const state = () => ({
    flags: git(fx.local, "ls-files", "-v", "--", "tracked.txt", "skip.txt"),
    tracked: readFileSync(join(fx.local, "tracked.txt"), "utf8"),
    skip: readFileSync(join(fx.local, "skip.txt"), "utf8"),
  });
  const before = state();
  const tx = transaction(fx);

  await tx.protect();
  await tx.rollback();

  assert.deepEqual(state(), before);
});

test("intent-to-add fails closed without changing its index metadata", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  writeFileSync(join(fx.local, "intent.txt"), "intent bytes\n");
  git(fx.local, "add", "--intent-to-add", "intent.txt");
  const state = () => ({
    status: gitHex(fx.local, "status", "--porcelain=v2", "-z"),
    debug: git(fx.local, "ls-files", "--debug", "--", "intent.txt"),
    bytes: readFileSync(join(fx.local, "intent.txt")).toString("hex"),
  });
  const before = state();
  const tx = transaction(fx);

  await assert.rejects(
    () => tx.protect(),
    /intent-to-add index entries cannot be snapshotted safely/u,
  );
  await tx.rollback();

  assert.deepEqual(state(), before);
});

test("partial raw materialization failure retains recovery and a retry restores exactly", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const before = prepareRawState(fx.local);
  const fail = join(fx.temp, "fail-materialization");
  const count = join(fx.temp, "cat-file-count");
  const tx = wrappedTransaction(
    fx,
    `if [ -f ${JSON.stringify(fail)} ] && [ "$1" = cat-file ] && [ "$2" = blob ]; then\n` +
      `  n=0; [ ! -f ${JSON.stringify(count)} ] || n=$(cat ${JSON.stringify(count)})\n` +
      "  n=$((n + 1))\n" +
      `  printf '%s' "$n" > ${JSON.stringify(count)}\n` +
      '  if [ "$n" -eq 2 ]; then\n' +
      "    printf '%s\\n' 'injected raw materialization failure' >&2\n" +
      "    exit 92\n" +
      "  fi\n" +
      "fi\n",
  );
  await tx.protect();
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  writeFileSync(fail, "fail\n");

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: injected raw materialization failure/u,
  );

  assert.equal(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    recoveryOid,
  );
  assert.match(
    git(fx.local, "stash", "list", "--format=%H"),
    new RegExp(recoveryOid, "u"),
  );
  rmSync(fail);
  rmSync(count, { force: true });

  await tx.rollback();

  assert.deepEqual(rawState(fx.local), before);
});

test("persistent restore apply failure keeps exact recovery and rolls back without apply", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const originalHead = git(fx.local, "rev-parse", "HEAD");
  const before = prepareRawState(fx.local);
  writeFileSync(join(fx.seed, "upstream.txt"), "upstream\n");
  git(fx.seed, "add", "upstream.txt");
  git(fx.seed, "commit", "-m", "upstream");
  git(fx.seed, "push", "origin", "main");
  const fail = join(fx.temp, "fail-restore-apply");
  const tx = wrappedTransaction(
    fx,
    `if [ -f ${JSON.stringify(fail)} ] && [ "$1" = stash ] && [ "$2" = apply ]; then\n` +
      "  printf '%s\\n' 'injected persistent restore apply failure' >&2\n" +
      "  exit 94\n" +
      "fi\n",
  );
  await tx.protect();
  await tx.resolveTarget();
  await tx.fetchAndIntegrate();
  writeFileSync(fail, "fail\n");

  await assert.rejects(
    () => tx.restoreLocalChanges(),
    /injected persistent restore apply failure/u,
  );

  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  assert.notEqual(recoveryOid, "");
  assert.match(
    git(fx.local, "stash", "list", "--format=%H"),
    new RegExp(recoveryOid, "u"),
  );
  rmSync(fail);
  await tx.rollback();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), originalHead);
  assert.deepEqual(rawState(fx.local), before);
});

test("protect-time raw materialization failure rolls back from the durable OID", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const before = prepareRawState(fx.local);
  const armed = join(fx.temp, "arm-materialization");
  const tx = wrappedTransaction(
    fx,
    `if [ "$1" = update-ref ] && [ "$#" -eq 4 ] && printf '%s' "$2" | grep -q '^refs/iva/update-recovery/'; then\n` +
      '  __REAL_GIT__ "$@"\n' +
      "  code=$?\n" +
      `  [ "$code" -ne 0 ] || : > ${JSON.stringify(armed)}\n` +
      '  exit "$code"\n' +
      "fi\n" +
      `if [ -f ${JSON.stringify(armed)} ] && [ "$1" = cat-file ] && [ "$2" = blob ]; then\n` +
      "  printf '%s\\n' 'injected protect materialization failure' >&2\n" +
      "  exit 93\n" +
      "fi\n",
  );

  await assert.rejects(
    () => tx.protect(),
    /injected protect materialization failure/u,
  );
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  assert.notEqual(recoveryOid, "");
  rmSync(armed);

  await tx.rollback();

  assert.deepEqual(rawState(fx.local), before);
});

test("rollback preserves a post-snapshot untracked file and reports incomplete recovery", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const before = prepareRawState(fx.local);
  const tx = transaction(fx);
  await tx.protect();
  const late = join(fx.local, "late-user.bin");
  const lateBytes = Buffer.from([9, 0, 255, 10]);
  writeFileSync(late, lateBytes);

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: git recovery snapshot untracked paths do not match/u,
  );

  assert.deepEqual(readFileSync(late), lateBytes);
  assert.notEqual(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    "",
  );
  rmSync(late);
  await tx.rollback();
  assert.deepEqual(rawState(fx.local), before);
});

test("a false-success clean reset is detected and remains retryable", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const fail = join(fx.temp, "false-reset-success");
  const tx = wrappedTransaction(
    fx,
    `if [ -f ${JSON.stringify(fail)} ] && [ "$1" = reset ] && [ "$2" = --hard ]; then\n` +
      "  exit 0\n" +
      "fi\n",
  );
  const originalHead = git(fx.local, "rev-parse", "HEAD");
  await tx.protect();
  writeFileSync(join(fx.local, "tracked.txt"), "new commit\n");
  git(fx.local, "add", "tracked.txt");
  git(fx.local, "commit", "-m", "simulate integrated update");
  writeFileSync(fail, "fail\n");

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: clean recovery rollback is incomplete/u,
  );

  rmSync(fail);
  await tx.rollback();
  assert.equal(git(fx.local, "rev-parse", "HEAD"), originalHead);
  assert.equal(readFileSync(join(fx.local, "tracked.txt"), "utf8"), "base\n");
});

test("one recovery cleanup failure cannot skip env, output or node_modules rollback", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  writeFileSync(join(fx.local, ".env"), "SECRET=before\n", { mode: 0o640 });
  mkdirSync(join(fx.local, ".output/server"), { recursive: true });
  writeFileSync(join(fx.local, ".output/server/marker.txt"), "old-output\n");
  mkdirSync(join(fx.local, "node_modules"), { recursive: true });
  writeFileSync(join(fx.local, "node_modules/marker.txt"), "old-modules\n");
  mkdirSync(join(fx.local, "locked"), { recursive: true });
  writeFileSync(
    join(fx.local, "locked/original.bin"),
    Buffer.from([0, 255, 7]),
  );

  writeFileSync(join(fx.seed, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(fx.seed, "tracked.txt"), "upstream\n");
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "upstream dependency update");
  git(fx.seed, "push", "origin", "main");

  const fakeNpm = join(fx.temp, "fake-npm");
  writeFileSync(
    fakeNpm,
    "#!/bin/sh\n" +
      'if [ "$1" = run ]; then\n' +
      "  mkdir -p .output/server\n" +
      "  printf '%s\\n' new-output > .output/server/marker.txt\n" +
      "else\n" +
      "  mkdir -p node_modules\n" +
      "  printf '%s\\n' new-modules > node_modules/marker.txt\n" +
      "fi\n",
  );
  chmodSync(fakeNpm, 0o755);
  let failRemoval = false;
  const tx = createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    recoveryFileOps: {
      remove(path) {
        if (failRemoval && path === join(fx.local, "locked/original.bin"))
          throw new Error("injected original-untracked cleanup failure");
        rmSync(path, { recursive: true, force: true });
      },
    },
  });

  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: fakeNpm });
  assert.ok(candidate);
  await tx.fetchAndIntegrate();
  await tx.restoreLocalChanges();
  assert.equal(await tx.promoteCandidate(), true);
  writeFileSync(join(fx.local, ".env"), "SECRET=changed\n", { mode: 0o600 });
  failRemoval = true;

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: injected original-untracked cleanup failure/u,
  );

  assert.equal(readFileSync(join(fx.local, ".env"), "utf8"), "SECRET=before\n");
  assert.equal(statSync(join(fx.local, ".env")).mode & 0o777, 0o640);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "old-output\n",
  );
  assert.equal(
    readFileSync(join(fx.local, "node_modules/marker.txt"), "utf8"),
    "old-modules\n",
  );
  assert.notEqual(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    "",
  );
  assert.notEqual(git(fx.local, "stash", "list", "--format=%H"), "");
  assert.deepEqual(
    readdirSync(fx.local).filter((name) =>
      name.startsWith(".output.iva-backup-"),
    ),
    [],
  );
  assert.deepEqual(
    readdirSync(fx.local).filter((name) =>
      name.startsWith("node_modules.iva-backup-"),
    ),
    [],
  );
  await tx.teardownCandidate();
});
