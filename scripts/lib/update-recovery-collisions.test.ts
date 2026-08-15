/* eslint-disable @typescript-eslint/no-floating-promises -- Node registers top-level tests synchronously. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createUpdateTransaction } from "./update-safety.ts";
import {
  addIgnoreRule,
  git,
  recoveryFixture as fixture,
  recoveryTransaction as transaction,
  wrappedRecoveryTransaction as wrappedTransaction,
} from "../fixtures/update-recovery.ts";

test("rollback restores an ignored binary when the target starts tracking its path", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "ignored.bin");

  const before = Buffer.from([1, 0, 254, 10]);
  writeFileSync(join(fx.local, "ignored.bin"), before);
  chmodSync(join(fx.local, "ignored.bin"), 0o640);
  writeFileSync(join(fx.seed, "ignored.bin"), Buffer.from([9, 0, 255, 10]));
  git(fx.seed, "add", "-f", "ignored.bin");
  git(fx.seed, "commit", "-m", "track former local path");
  git(fx.seed, "push", "origin", "main");

  const tx = transaction(fx);
  await tx.protect();
  const recoveryOid = git(
    fx.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  const metadataPrefix = "iva-recovery-metadata-v1:";
  const metadataLine = git(fx.local, "show", "-s", "--format=%B", recoveryOid)
    .split("\n")
    .find((line) => line.startsWith(metadataPrefix));
  assert.ok(metadataLine);
  const metadata: unknown = JSON.parse(
    Buffer.from(
      metadataLine.slice(metadataPrefix.length),
      "base64url",
    ).toString("utf8"),
  );
  assert.deepEqual(metadata, {
    schema: "iva-update-recovery/v1",
    indexFlags: { assumeUnchanged: [], skipWorktree: [] },
    worktreePermissions: {},
    untrackedPermissions: { "ignored.bin": 0o640 },
    ignoredCollisionPaths: ["ignored.bin"],
    ignoredCollisionDirectories: {},
    ignoredCollisionScopes: ["ignored.bin"],
  });
  const target = await tx.resolveTarget();
  assert.equal(target.plan, "fast-forward");
  await tx.fetchAndIntegrate();

  await tx.rollback();

  assert.deepEqual(readFileSync(join(fx.local, "ignored.bin")), before);
  assert.equal(statSync(join(fx.local, "ignored.bin")).mode & 0o777, 0o640);
});

test("rollback restores an ignored directory when the target replaces it with a file", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "ignored-dir/");
  mkdirSync(join(fx.local, "ignored-dir/deep"), { recursive: true });
  chmodSync(join(fx.local, "ignored-dir"), 0o750);
  chmodSync(join(fx.local, "ignored-dir/deep"), 0o710);
  const bytes = Buffer.from([0, 7, 255, 10]);
  writeFileSync(join(fx.local, "ignored-dir/deep/data.bin"), bytes);
  chmodSync(join(fx.local, "ignored-dir/deep/data.bin"), 0o600);
  writeFileSync(join(fx.seed, "ignored-dir"), "new tracked file\n");
  git(fx.seed, "add", "-f", "ignored-dir");
  git(fx.seed, "commit", "-m", "replace ignored directory");
  git(fx.seed, "push", "origin", "main");

  const tx = transaction(fx);
  await tx.protect();
  assert.equal(existsSync(join(fx.local, "ignored-dir")), false);
  await tx.fetchAndIntegrate();
  await tx.rollback();

  assert.deepEqual(
    readFileSync(join(fx.local, "ignored-dir/deep/data.bin")),
    bytes,
  );
  assert.equal(statSync(join(fx.local, "ignored-dir")).mode & 0o777, 0o750);
  assert.equal(
    statSync(join(fx.local, "ignored-dir/deep")).mode & 0o777,
    0o710,
  );
  assert.equal(
    statSync(join(fx.local, "ignored-dir/deep/data.bin")).mode & 0o777,
    0o600,
  );
});

test("a successful directory-to-file update preserves only ignored leaves", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "ignored-dir/");
  mkdirSync(join(fx.local, "ignored-dir/deep"), { recursive: true });
  const localBytes = Buffer.from([0, 6, 255, 10]);
  writeFileSync(join(fx.local, "ignored-dir/deep/data.bin"), localBytes);
  writeFileSync(join(fx.seed, "ignored-dir"), "target file\n");
  git(fx.seed, "add", "-f", "ignored-dir");
  git(fx.seed, "commit", "-m", "replace ignored directory successfully");
  git(fx.seed, "push", "origin", "main");

  const tx = transaction(fx);
  await tx.protect();
  await tx.fetchAndIntegrate();
  const report = await tx.restoreLocalChanges();

  assert.equal(report.status, "preserved");
  assert.equal(
    readFileSync(join(fx.local, "ignored-dir"), "utf8"),
    "target file\n",
  );
  assert.deepEqual(
    report.conflicts.map(({ path }) => path),
    ["ignored-dir/deep/data.bin"],
  );
  assert.deepEqual(
    execFileSync(
      "git",
      ["show", `${report.stashOid}^3:ignored-dir/deep/data.bin`],
      {
        cwd: fx.local,
      },
    ),
    localBytes,
  );
});

test("a target file can replace tracked and ignored descendants together", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "tree/cache.bin");
  mkdirSync(join(fx.seed, "tree"));
  writeFileSync(join(fx.seed, "tree/core.txt"), "old core\n");
  git(fx.seed, "add", "tree/core.txt");
  git(fx.seed, "commit", "-m", "add tracked descendant");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  const localBytes = Buffer.from([7, 0, 253]);
  writeFileSync(join(fx.local, "tree/cache.bin"), localBytes);
  rmSync(join(fx.seed, "tree"), { recursive: true });
  writeFileSync(join(fx.seed, "tree"), "target file\n");
  git(fx.seed, "add", "-A");
  git(fx.seed, "commit", "-m", "replace tracked directory");
  git(fx.seed, "push", "origin", "main");

  const tx = transaction(fx);
  await tx.protect();
  await tx.fetchAndIntegrate();
  const report = await tx.restoreLocalChanges();

  assert.equal(report.status, "preserved");
  assert.equal(readFileSync(join(fx.local, "tree"), "utf8"), "target file\n");
  assert.deepEqual(
    execFileSync("git", ["show", `${report.stashOid}^3:tree/cache.bin`], {
      cwd: fx.local,
    }),
    localBytes,
  );
});

test("a new ignored descendant aborts before any captured leaf is removed", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "tree/*.bin");
  mkdirSync(join(fx.seed, "tree"));
  writeFileSync(join(fx.seed, "tree/core.txt"), "old core\n");
  git(fx.seed, "add", "tree/core.txt");
  git(fx.seed, "commit", "-m", "add guarded tracked descendant");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  writeFileSync(join(fx.local, "tree/cache.bin"), "captured");
  rmSync(join(fx.seed, "tree"), { recursive: true });
  writeFileSync(join(fx.seed, "tree"), "target file\n");
  git(fx.seed, "add", "-A");
  git(fx.seed, "commit", "-m", "replace guarded directory");
  git(fx.seed, "push", "origin", "main");
  const marker = join(fx.temp, "descendant-armed");
  const foreign = join(fx.local, "tree/foreign.bin");
  const tx = wrappedTransaction(
    fx,
    `if [ "$1" = "status" ] && [ "$2" = "--porcelain=v1" ]; then
  __REAL_GIT__ "$@"
  result=$?
  if [ "$result" -eq 0 ] && [ ! -e ${JSON.stringify(marker)} ]; then
    printf foreign > ${JSON.stringify(foreign)}
    : > ${JSON.stringify(marker)}
  fi
  exit "$result"
fi`,
  );

  await assert.rejects(
    () => tx.protect(),
    /ignored recovery collision path set changed/u,
  );

  assert.equal(
    readFileSync(join(fx.local, "tree/cache.bin"), "utf8"),
    "captured",
  );
  assert.equal(readFileSync(foreign, "utf8"), "foreign");
});

test("replacement before ignored removal fails without deleting the foreign directory", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "claimed.bin");
  const collision = join(fx.local, "claimed.bin");
  const marker = join(fx.temp, "replacement-armed");
  writeFileSync(collision, Buffer.from([1, 0, 3]));
  writeFileSync(join(fx.seed, "claimed.bin"), Buffer.from([2, 0, 4]));
  git(fx.seed, "add", "-f", "claimed.bin");
  git(fx.seed, "commit", "-m", "claim ignored path");
  git(fx.seed, "push", "origin", "main");
  const tx = wrappedTransaction(
    fx,
    `if [ "$1" = "status" ] && [ "$2" = "--porcelain=v1" ]; then
  __REAL_GIT__ "$@"
  result=$?
  if [ "$result" -eq 0 ] && [ ! -e ${JSON.stringify(marker)} ]; then
    rm -f ${JSON.stringify(collision)}
    mkdir ${JSON.stringify(collision)}
    printf foreign > ${JSON.stringify(join(collision, "foreign.bin"))}
    : > ${JSON.stringify(marker)}
  fi
  exit "$result"
fi`,
  );

  await assert.rejects(
    () => tx.protect(),
    /ignored recovery collision ownership changed: claimed\.bin/u,
  );

  assert.equal(lstatSync(collision).isDirectory(), true);
  assert.equal(readFileSync(join(collision, "foreign.bin"), "utf8"), "foreign");
  assert.notEqual(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(refname)",
      "refs/iva/update-recovery",
    ),
    "",
  );
});

test("rollback restores an ignored symlink when the target creates descendants below it", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "ignored-link");
  mkdirSync(join(fx.local, "private"));
  writeFileSync(join(fx.local, "private/data.bin"), Buffer.from([4, 0, 255]));
  symlinkSync("private", join(fx.local, "ignored-link"));
  mkdirSync(join(fx.seed, "ignored-link"));
  writeFileSync(join(fx.seed, "ignored-link/core.txt"), "tracked child\n");
  git(fx.seed, "add", "-f", "ignored-link/core.txt");
  git(fx.seed, "commit", "-m", "replace ignored symlink");
  git(fx.seed, "push", "origin", "main");

  const tx = transaction(fx);
  await tx.protect();
  assert.equal(existsSync(join(fx.local, "ignored-link")), false);
  await tx.fetchAndIntegrate();
  await tx.rollback();

  assert.equal(
    lstatSync(join(fx.local, "ignored-link")).isSymbolicLink(),
    true,
  );
  assert.equal(readlinkSync(join(fx.local, "ignored-link")), "private");
  assert.deepEqual(
    readFileSync(join(fx.local, "private/data.bin")),
    Buffer.from([4, 0, 255]),
  );
});

test("rollback restores an ignored file when the target creates a directory", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "claimed");
  const bytes = Buffer.from([5, 0, 254, 10]);
  writeFileSync(join(fx.local, "claimed"), bytes, { mode: 0o640 });
  mkdirSync(join(fx.seed, "claimed"));
  writeFileSync(join(fx.seed, "claimed/child.txt"), "target child\n");
  git(fx.seed, "add", "-f", "claimed/child.txt");
  git(fx.seed, "commit", "-m", "replace ignored file with directory");
  git(fx.seed, "push", "origin", "main");

  const tx = transaction(fx);
  await tx.protect();
  await tx.fetchAndIntegrate();
  await tx.rollback();

  assert.deepEqual(readFileSync(join(fx.local, "claimed")), bytes);
  assert.equal(statSync(join(fx.local, "claimed")).mode & 0o777, 0o640);
});

test("an unsupported ignored collision fails before live-tree mutation", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "claimed.pipe");
  execFileSync("mkfifo", [join(fx.local, "claimed.pipe")]);
  writeFileSync(join(fx.seed, "claimed.pipe"), "target\n");
  git(fx.seed, "add", "-f", "claimed.pipe");
  git(fx.seed, "commit", "-m", "claim unsupported local type");
  git(fx.seed, "push", "origin", "main");
  const beforeHead = git(fx.local, "rev-parse", "HEAD");
  const tx = transaction(fx);

  await assert.rejects(
    () => tx.protect(),
    /unsupported ignored collision: claimed\.pipe/u,
  );

  assert.equal(lstatSync(join(fx.local, "claimed.pipe")).isFIFO(), true);
  assert.equal(git(fx.local, "rev-parse", "HEAD"), beforeHead);
});

test("non-colliding ignored bytes remain untouched across update and rollback", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "keep.bin");
  const keep = join(fx.local, "keep.bin");
  const bytes = Buffer.from([8, 0, 3, 255]);
  writeFileSync(keep, bytes);
  chmodSync(keep, 0o620);
  const before = statSync(keep);
  writeFileSync(join(fx.seed, "upstream.txt"), "upstream\n");
  git(fx.seed, "add", "upstream.txt");
  git(fx.seed, "commit", "-m", "unrelated target path");
  git(fx.seed, "push", "origin", "main");

  const tx = transaction(fx);
  await tx.protect();
  assert.deepEqual(readFileSync(keep), bytes);
  await tx.fetchAndIntegrate();
  await tx.rollback();

  const after = statSync(keep);
  assert.deepEqual(readFileSync(keep), bytes);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o620);
});

test("a literal ignored collision stays recoverable after a successful update", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const path = ":(glob)*";
  addIgnoreRule(fx, "/:(glob)\\*");
  const localBytes = Buffer.from([0, 2, 255, 10]);
  writeFileSync(join(fx.local, path), localBytes);
  writeFileSync(join(fx.seed, path), Buffer.from([8, 8, 8]));
  git(fx.seed, "add", "-f", "--", path);
  git(fx.seed, "commit", "-m", "track literal collision");
  git(fx.seed, "push", "origin", "main");

  const tx = transaction(fx);
  await tx.protect();
  await tx.fetchAndIntegrate();
  const report = await tx.restoreLocalChanges();
  assert.equal(report.status, "preserved");
  await tx.commit();

  assert.deepEqual(readFileSync(join(fx.local, path)), Buffer.from([8, 8, 8]));
  assert.ok(report.status === "preserved");
  assert.deepEqual(
    execFileSync("git", ["show", `${report.stashOid}^3:${path}`], {
      cwd: fx.local,
    }),
    localBytes,
  );
  assert.notEqual(
    git(
      fx.local,
      "for-each-ref",
      "--format=%(refname)",
      "refs/iva/update-recovery",
    ),
    "",
  );
});

test("collision capture and integration use one immutable target OID", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "claimed.bin");
  const localBytes = Buffer.from([1, 0, 255]);
  writeFileSync(join(fx.local, "claimed.bin"), localBytes);
  writeFileSync(join(fx.seed, "claimed.bin"), Buffer.from([2, 0, 254]));
  git(fx.seed, "add", "-f", "claimed.bin");
  git(fx.seed, "commit", "-m", "first immutable target");
  git(fx.seed, "push", "origin", "main");
  const firstTarget = git(fx.seed, "rev-parse", "HEAD");

  const tx = transaction(fx);
  await tx.protect();
  writeFileSync(join(fx.seed, "later.txt"), "later\n");
  git(fx.seed, "add", "later.txt");
  git(fx.seed, "commit", "-m", "move remote after capture");
  git(fx.seed, "push", "origin", "main");

  const target = await tx.resolveTarget();
  assert.equal(target.remote, firstTarget);
  await tx.fetchAndIntegrate();
  assert.equal(git(fx.local, "rev-parse", "HEAD"), firstTarget);
  assert.equal(existsSync(join(fx.local, "later.txt")), false);
  await tx.rollback();
  assert.deepEqual(readFileSync(join(fx.local, "claimed.bin")), localBytes);
});

test("partial ignored collision removal rolls back exactly and remains retryable", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  addIgnoreRule(fx, "claimed/");
  mkdirSync(join(fx.local, "claimed"));
  const first = Buffer.from([1, 0, 3]);
  const second = Buffer.from([2, 0, 4]);
  writeFileSync(join(fx.local, "claimed/a.bin"), first);
  writeFileSync(join(fx.local, "claimed/b.bin"), second);
  writeFileSync(join(fx.seed, "claimed"), "target file\n");
  git(fx.seed, "add", "-f", "claimed");
  git(fx.seed, "commit", "-m", "replace partially removed directory");
  git(fx.seed, "push", "origin", "main");
  let armed = true;
  const tx = createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    recoveryFileOps: {
      remove(path) {
        rmSync(path, { recursive: true, force: true });
      },
      removeCollisionLeaf(path) {
        if (armed && path === join(fx.local, "claimed/b.bin")) {
          armed = false;
          throw new Error("injected ignored collision removal failure");
        }
        unlinkSync(path);
      },
    },
  });

  await assert.rejects(
    () => tx.protect(),
    /injected ignored collision removal failure/u,
  );
  await tx.rollback();
  assert.deepEqual(readFileSync(join(fx.local, "claimed/a.bin")), first);
  assert.deepEqual(readFileSync(join(fx.local, "claimed/b.bin")), second);
  await tx.rollback();
  assert.deepEqual(readFileSync(join(fx.local, "claimed/a.bin")), first);
  assert.deepEqual(readFileSync(join(fx.local, "claimed/b.bin")), second);
});

test("new target entries below managed paths fail before live-tree mutation", async (t) => {
  for (const managed of [".env", ".output", "node_modules"] as const) {
    await t.test(managed, async (t) => {
      const fx = fixture();
      t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
      const targetPath = managed === ".env" ? managed : `${managed}/owned.txt`;
      if (managed === ".env")
        writeFileSync(join(fx.local, managed), "LOCAL=1\n");
      else {
        mkdirSync(join(fx.local, managed));
        writeFileSync(join(fx.local, managed, "local.txt"), "local\n");
        mkdirSync(join(fx.seed, managed), { recursive: true });
      }
      writeFileSync(join(fx.seed, targetPath), "target\n");
      git(fx.seed, "add", "-f", targetPath);
      git(fx.seed, "commit", "-m", `claim managed ${managed}`);
      git(fx.seed, "push", "origin", "main");
      const before =
        managed === ".env"
          ? readFileSync(join(fx.local, managed))
          : readFileSync(join(fx.local, managed, "local.txt"));
      const tx = transaction(fx);

      await assert.rejects(() => tx.protect(), {
        message: `update target collides with managed path: ${managed}`,
      });
      await tx.rollback();

      assert.deepEqual(
        managed === ".env"
          ? readFileSync(join(fx.local, managed))
          : readFileSync(join(fx.local, managed, "local.txt")),
        before,
      );
    });
  }
});
