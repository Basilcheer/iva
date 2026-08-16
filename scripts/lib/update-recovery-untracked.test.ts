/* eslint-disable @typescript-eslint/no-floating-promises -- Node registers top-level tests synchronously. */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createUpdateTransaction } from "./update-safety.ts";
import {
  git,
  recoveryFixture as fixture,
  recoveryTransaction as transaction,
  wrappedRecoveryTransaction as wrappedTransaction,
} from "../fixtures/update-recovery.ts";

type Shape = "directory" | "file" | "symlink";

function writeShape(path: string, shape: Shape, foreign = false): void {
  if (shape === "directory") {
    mkdirSync(join(path, "deep"), { recursive: true });
    chmodSync(path, foreign ? 0o750 : 0o710);
    writeFileSync(
      join(path, "deep", foreign ? "foreign.bin" : "original.bin"),
      foreign ? Buffer.from([9, 0, 255, 10]) : Buffer.from([1, 0, 254, 10]),
    );
    return;
  }
  if (shape === "symlink") {
    symlinkSync(foreign ? "foreign-target" : "original-target", path);
    return;
  }
  writeFileSync(
    path,
    foreign ? Buffer.from([8, 0, 253, 10]) : Buffer.from([2, 0, 252, 10]),
  );
  chmodSync(path, foreign ? 0o600 : 0o640);
}

function treeState(path: string): unknown {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink())
    return { kind: "symlink", target: readlinkSync(path, "utf8") };
  if (stat.isFile())
    return {
      kind: "file",
      bytes: readFileSync(path).toString("hex"),
      mode: stat.mode & 0o777,
    };
  return {
    kind: "directory",
    mode: stat.mode & 0o777,
    children: Object.fromEntries(
      readdirSync(path)
        .sort()
        .map((name) => [name, treeState(join(path, name))]),
    ),
  };
}

function recoveryOid(root: string): string {
  return git(
    root,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
}

test("rollback preserves a foreign directory that replaced an owned untracked file", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const claimed = join(fx.local, "claimed.txt");
  const foreign = join(claimed, "foreign.bin");
  writeFileSync(claimed, "original\n");
  const tx = transaction(fx);

  await tx.protect();
  assert.equal(existsSync(claimed), false);
  mkdirSync(claimed);
  writeFileSync(foreign, Buffer.from([9, 0, 255, 10]));
  const rollbackError = await tx.rollback().then(
    () => null,
    (error: unknown) => error,
  );

  assert.equal(existsSync(foreign), true);
  assert.equal(lstatSync(claimed).isDirectory(), true);
  assert.deepEqual(readFileSync(foreign), Buffer.from([9, 0, 255, 10]));
  assert.match(
    String(rollbackError),
    /untracked recovery ownership changed: claimed\.txt/u,
  );
  assert.notEqual(recoveryOid(fx.local), "");
});

test("rollback preserves every foreign kind which replaces an owned untracked path", async (t) => {
  const cases: Array<{ original: Shape; foreign: Shape }> = [
    { original: "file", foreign: "directory" },
    { original: "file", foreign: "symlink" },
    { original: "directory", foreign: "file" },
    { original: "directory", foreign: "symlink" },
    { original: "symlink", foreign: "file" },
    { original: "symlink", foreign: "directory" },
  ];
  for (const entry of cases) {
    await t.test(`${entry.original} to ${entry.foreign}`, async (t) => {
      const fx = fixture();
      t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
      const claimed = join(fx.local, "claimed");
      writeShape(claimed, entry.original);
      const tx = transaction(fx);
      await tx.protect();
      writeShape(claimed, entry.foreign, true);
      const foreignState = treeState(claimed);

      await assert.rejects(
        () => tx.rollback(),
        /untracked recovery ownership changed/u,
      );

      assert.deepEqual(treeState(claimed), foreignState);
      assert.notEqual(recoveryOid(fx.local), "");
    });
  }
});

test("rollback rejects byte-identical inode replacements for every owned kind", async (t) => {
  for (const shape of ["file", "directory", "symlink"] as const) {
    await t.test(shape, async (t) => {
      const fx = fixture();
      t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
      const claimed = join(fx.local, "claimed");
      writeShape(claimed, shape);
      const originalInode = lstatSync(claimed).ino;
      const originalState = treeState(claimed);
      const tx = transaction(fx);
      await tx.protect();
      writeShape(claimed, shape);
      assert.notEqual(lstatSync(claimed).ino, originalInode);

      await assert.rejects(
        () => tx.rollback(),
        /untracked recovery ownership changed: claimed/u,
      );

      assert.deepEqual(treeState(claimed), originalState);
      assert.notEqual(recoveryOid(fx.local), "");
    });
  }
});

test("a same-inode content and mode mutation survives a repeated rollback", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const claimed = join(fx.local, "claimed.bin");
  writeShape(claimed, "file");
  const tx = transaction(fx);
  await tx.protect();
  await tx.rollback();
  const ownedInode = lstatSync(claimed).ino;
  const foreign = Buffer.from([7, 0, 251, 10]);
  writeFileSync(claimed, foreign);
  chmodSync(claimed, 0o604);
  assert.equal(lstatSync(claimed).ino, ownedInode);

  await assert.rejects(
    () => tx.rollback(),
    /untracked recovery ownership changed: claimed\.bin/u,
  );

  assert.deepEqual(readFileSync(claimed), foreign);
  assert.equal(lstatSync(claimed).mode & 0o777, 0o604);
  assert.notEqual(recoveryOid(fx.local), "");
});

test("a new nested child survives and invalidates complete directory ownership", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const claimed = join(fx.local, "claimed");
  writeShape(claimed, "directory");
  const tx = transaction(fx);
  await tx.protect();
  await tx.rollback();
  const directoryInode = lstatSync(claimed).ino;
  const foreign = join(claimed, "deep", "late.bin");
  const foreignBytes = Buffer.from([6, 0, 250, 10]);
  writeFileSync(foreign, foreignBytes);

  await assert.rejects(
    () => tx.rollback(),
    /untracked recovery ownership changed: claimed\/deep/u,
  );

  assert.equal(lstatSync(claimed).ino, directoryInode);
  assert.deepEqual(readFileSync(foreign), foreignBytes);
  assert.notEqual(recoveryOid(fx.local), "");
});

test("an async replacement during rollback survives create-if-absent restore", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const claimed = join(fx.local, "claimed.bin");
  const arm = join(fx.temp, "arm-replacement");
  const foreign = join(claimed, "foreign.bin");
  writeFileSync(claimed, "original\n");
  const tx = wrappedTransaction(
    fx,
    `if [ -f ${JSON.stringify(arm)} ] && [ "$1" = reset ] && [ "$2" = --hard ]; then
  mkdir ${JSON.stringify(claimed)}
  printf foreign > ${JSON.stringify(foreign)}
  __REAL_GIT__ "$@"
  exit $?
fi`,
  );
  await tx.protect();
  writeFileSync(arm, "armed\n");

  await assert.rejects(
    () => tx.rollback(),
    /untracked recovery ownership changed: claimed\.bin/u,
  );

  assert.equal(readFileSync(foreign, "utf8"), "foreign");
  assert.notEqual(recoveryOid(fx.local), "");
});

test("rollback fails before reset when the current index claims an original untracked path", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const claimed = join(fx.local, "claimed.txt");
  writeFileSync(claimed, "local original\n");
  writeFileSync(join(fx.seed, "claimed.txt"), "target bytes\n");
  git(fx.seed, "add", "claimed.txt");
  git(fx.seed, "commit", "-m", "claim ordinary untracked path");
  git(fx.seed, "push", "origin", "main");
  const tx = transaction(fx);
  await tx.protect();
  await tx.fetchAndIntegrate();
  const oid = recoveryOid(fx.local);

  await assert.rejects(
    () => tx.rollback(),
    /untracked recovery path overlaps the current index: claimed\.txt/u,
  );

  assert.equal(readFileSync(claimed, "utf8"), "target bytes\n");
  assert.equal(git(fx.local, "show", `${oid}^3:claimed.txt`), "local original");
  assert.equal(recoveryOid(fx.local), oid);
});

test("captured parent identity blocks retargets before and after each restore primitive", async (t) => {
  for (const phase of ["before", "after"] as const) {
    for (const shape of ["file", "symlink", "directory"] as const) {
      await t.test(`${phase} ${shape}`, async (t) => {
        const fx = fixture();
        t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
        mkdirSync(join(fx.seed, "container"));
        writeFileSync(join(fx.seed, "container/keep.txt"), "tracked\n");
        git(fx.seed, "add", "container/keep.txt");
        git(fx.seed, "commit", "-m", "add tracked parent");
        git(fx.seed, "push", "origin", "main");
        git(fx.local, "pull", "--ff-only");
        const parent = join(fx.local, "container");
        const movedParent = join(fx.local, "captured-container");
        const claimed = join(parent, "claimed");
        const relative = "container/claimed";
        writeShape(claimed, shape);
        let retargeted = false;
        const retarget = (): void => {
          if (retargeted) return;
          retargeted = true;
          renameSync(parent, movedParent);
          mkdirSync(parent);
          writeFileSync(join(parent, "foreign.bin"), "foreign\n");
        };
        const tx = createUpdateTransaction({
          root: fx.local,
          dataDir: fx.data,
          envPath: join(fx.local, ".env"),
          recoveryFileOps: {
            remove(path) {
              rmSync(path, { recursive: true, force: true });
            },
            beforeCreate(kind, path) {
              if (phase === "before" && kind === shape && path === relative)
                retarget();
            },
            afterCreate(kind, path) {
              if (phase === "after" && kind === shape && path === relative)
                retarget();
            },
          },
        });
        await tx.protect();

        await assert.rejects(
          () => tx.rollback(),
          /untracked recovery ownership changed: container/u,
        );

        assert.equal(retargeted, true);
        assert.equal(existsSync(join(parent, "foreign.bin")), true);
        assert.equal(existsSync(join(parent, "claimed")), false);
        const movedClaimed = join(movedParent, "claimed");
        if (phase === "before") assert.equal(existsSync(movedClaimed), false);
        else if (shape === "file")
          assert.equal(readFileSync(movedClaimed).byteLength, 0);
        else if (shape === "symlink")
          assert.equal(lstatSync(movedClaimed).isSymbolicLink(), true);
        else assert.equal(lstatSync(movedClaimed).isDirectory(), true);
        assert.notEqual(recoveryOid(fx.local), "");
      });
    }
  }
});

test("a directory barrier failure retains recovery and a retry confirms every changed ancestor", async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.temp, { recursive: true, force: true }));
  const claimed = join(fx.local, "owned/deep/claimed.bin");
  mkdirSync(join(fx.local, "owned/deep"), { recursive: true });
  writeFileSync(claimed, Buffer.from([5, 0, 249, 10]));
  let failBarrier = true;
  const synced: string[] = [];
  const tx = createUpdateTransaction({
    root: fx.local,
    dataDir: fx.data,
    envPath: join(fx.local, ".env"),
    recoveryFileOps: {
      remove(path) {
        rmSync(path, { recursive: true, force: true });
      },
      syncDirectory(path, sync) {
        synced.push(path);
        if (failBarrier) throw new Error("injected directory barrier failure");
        sync();
      },
    },
  });
  await tx.protect();

  await assert.rejects(
    () => tx.rollback(),
    /update rollback incomplete: injected directory barrier failure/u,
  );

  assert.deepEqual(readFileSync(claimed), Buffer.from([5, 0, 249, 10]));
  const oid = recoveryOid(fx.local);
  assert.notEqual(oid, "");
  failBarrier = false;
  synced.length = 0;
  await tx.rollback();

  assert.deepEqual(synced, [
    join(fx.local, "owned/deep"),
    join(fx.local, "owned"),
    fx.local,
  ]);
  assert.equal(recoveryOid(fx.local), oid);
  await tx.commit();
  assert.equal(recoveryOid(fx.local), oid);
});
