/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  fstatSync,
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
import test, { type TestContext } from "node:test";
import {
  captureDirectoryLease,
  releaseDirectoryLease,
  type ResourceIdentityHooks,
  verifyDirectoryLease,
} from "./update-resource-identity.ts";
import { UpdateResourceOwners } from "./update-resource-owners.ts";

function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), "iva-resource-owner-"));
  const root = join(temp, "root");
  const data = join(temp, "data");
  mkdirSync(root);
  mkdirSync(data);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return { temp, root, data, env: join(root, ".env") };
}

function owner(
  fx: ReturnType<typeof fixture>,
  logFile?: string,
  identityHooks?: ResourceIdentityHooks,
) {
  return new UpdateResourceOwners({
    root: fx.root,
    dataDir: fx.data,
    envPath: fx.env,
    ...(logFile ? { logFile } : {}),
    ...(identityHooks ? { identityHooks } : {}),
    timestamp: () => "stamp",
  });
}

function onlyBackup(root: string, prefix: string): string {
  const matches = readdirSync(root).filter((name) => name.startsWith(prefix));
  assert.equal(matches.length, 1);
  return join(root, matches[0] ?? "missing");
}

test("a held directory lease prevents same-inode replacement ABA", (t) => {
  const fx = fixture(t);
  const path = join(fx.root, ".output");
  mkdirSync(path);
  const lease = captureDirectoryLease(path, "output");
  t.after(() => releaseDirectoryLease(lease));
  const held = fstatSync(lease.descriptor, { bigint: true });

  rmSync(path, { recursive: true });
  mkdirSync(path);

  assert.notEqual(statSync(path, { bigint: true }).ino, held.ino);
  assert.throws(
    () => verifyDirectoryLease(path, lease, "output"),
    /ownership changed/u,
  );
});

test("an absent environment replacement survives rollback", (t) => {
  const fx = fixture(t);
  const resources = owner(fx);
  resources.protectEnvironment();
  mkdirSync(fx.env);
  writeFileSync(join(fx.env, "foreign.bin"), Buffer.from([0, 255, 7]));

  const errors = resources.rollback();

  assert.equal(errors.length, 1);
  assert.deepEqual(
    readFileSync(join(fx.env, "foreign.bin")),
    Buffer.from([0, 255, 7]),
  );
});

test("a failed build's partial output is adopted before rollback", (t) => {
  const fx = fixture(t);
  const live = join(fx.root, ".output");
  mkdirSync(live);
  writeFileSync(join(live, "server"), "old build\n");
  const resources = owner(fx);
  resources.backupOutput();
  mkdirSync(live);
  writeFileSync(join(live, "partial"), "failed build\n");

  resources.adoptOutput();
  const errors = resources.rollback();

  assert.deepEqual(errors, []);
  assert.equal(readFileSync(join(live, "server"), "utf8"), "old build\n");
  assert.equal(readdirSync(live).includes("partial"), false);
});

test("a replacement environment file is not overwritten from backup", (t) => {
  const fx = fixture(t);
  writeFileSync(fx.env, "original\n", { mode: 0o640 });
  const resources = owner(fx);
  resources.protectEnvironment();
  rmSync(fx.env);
  writeFileSync(fx.env, "foreign\n", { mode: 0o600 });

  const errors = resources.rollback();

  assert.equal(errors.length, 1);
  assert.equal(readFileSync(fx.env, "utf8"), "foreign\n");
});

test("same-inode environment bytes and mode remain foreign", (t) => {
  const fx = fixture(t);
  writeFileSync(fx.env, "original\n", { mode: 0o640 });
  const resources = owner(fx);
  resources.protectEnvironment();
  const inode = statSync(fx.env).ino;
  writeFileSync(fx.env, "foreign\n");
  chmodSync(fx.env, 0o600);
  assert.equal(statSync(fx.env).ino, inode);

  const errors = resources.rollback();

  assert.equal(errors.length, 1);
  assert.equal(readFileSync(fx.env, "utf8"), "foreign\n");
  assert.equal(statSync(fx.env).mode & 0o777, 0o600);
});

test("a replacement environment backup stays foreign", (t) => {
  const fx = fixture(t);
  writeFileSync(fx.env, "original\n", { mode: 0o640 });
  const resources = owner(fx);
  resources.protectEnvironment();
  const backup = onlyBackup(join(fx.data, "update-backups"), ".env-stamp-");
  rmSync(backup, { recursive: true });
  writeFileSync(backup, "foreign-backup\n");

  const errors = resources.rollback();

  assert.equal(errors.length, 1);
  assert.equal(readFileSync(backup, "utf8"), "foreign-backup\n");
  assert.equal(readFileSync(fx.env, "utf8"), "original\n");
});

for (const resource of [".output", "node_modules"] as const) {
  test(`${resource} live foreign child preserves the whole tree on rollback`, (t) => {
    const fx = fixture(t);
    const live = join(fx.root, resource);
    const source = join(fx.temp, `${resource.slice(1)}-source`);
    mkdirSync(live);
    writeFileSync(join(live, "old"), "old\n");
    mkdirSync(source);
    writeFileSync(join(source, "owned"), "owned\n");
    const resources = owner(fx);
    if (resource === ".output") resources.promoteOutput(source);
    else resources.promoteNodeModules(source);
    writeFileSync(join(live, "foreign"), "foreign\n");

    const errors = resources.rollback();

    assert.equal(errors.length, 1);
    assert.equal(readFileSync(join(live, "owned"), "utf8"), "owned\n");
    assert.equal(readFileSync(join(live, "foreign"), "utf8"), "foreign\n");
    assert.equal(
      existsSync(onlyBackup(fx.root, `${resource}.iva-backup-`)),
      true,
    );

    rmSync(join(live, "foreign"));
    assert.deepEqual(resources.rollback(), []);
    assert.equal(readFileSync(join(live, "old"), "utf8"), "old\n");
  });

  test(`${resource} cleanup retains a backup with a foreign child`, (t) => {
    const fx = fixture(t);
    const logFile = join(fx.temp, "cleanup.log");
    const live = join(fx.root, resource);
    const source = join(fx.temp, `${resource.slice(1)}-source`);
    mkdirSync(live);
    writeFileSync(join(live, "old"), "old\n");
    mkdirSync(source);
    writeFileSync(join(source, "new"), "new\n");
    const resources = owner(fx, logFile);
    if (resource === ".output") resources.promoteOutput(source);
    else resources.promoteNodeModules(source);
    const backup = join(
      onlyBackup(fx.root, `${resource}.iva-backup-`),
      "owned",
    );
    writeFileSync(join(backup, "foreign"), "foreign\n");

    resources.cleanup();

    assert.equal(readFileSync(join(backup, "old"), "utf8"), "old\n");
    assert.equal(readFileSync(join(backup, "foreign"), "utf8"), "foreign\n");
    assert.match(readFileSync(logFile, "utf8"), /ownership changed/u);

    rmSync(join(backup, "foreign"));
    resources.cleanup();
    assert.equal(existsSync(backup), false);
  });

  test(`${resource} live replacement survives rollback`, (t) => {
    const fx = fixture(t);
    const live = join(fx.root, resource);
    const source = join(fx.temp, `${resource.slice(1)}-source`);
    mkdirSync(live);
    writeFileSync(join(live, "old.bin"), Buffer.from([1, 2, 3]));
    mkdirSync(source);
    writeFileSync(join(source, "new.bin"), Buffer.from([4, 5, 6]));
    const resources = owner(fx);
    if (resource === ".output") resources.promoteOutput(source);
    else resources.promoteNodeModules(source);
    rmSync(live, { recursive: true });
    mkdirSync(live);
    writeFileSync(join(live, "foreign.bin"), Buffer.from([7, 8, 9]));

    const errors = resources.rollback();

    assert.equal(errors.length, 1);
    assert.deepEqual(
      readFileSync(join(live, "foreign.bin")),
      Buffer.from([7, 8, 9]),
    );
  });

  test(`${resource} backup replacement blocks rollback before live mutation`, (t) => {
    const fx = fixture(t);
    const live = join(fx.root, resource);
    const source = join(fx.temp, `${resource.slice(1)}-source`);
    mkdirSync(live);
    writeFileSync(join(live, "old"), "old\n");
    mkdirSync(source);
    writeFileSync(join(source, "new"), "new\n");
    const resources = owner(fx);
    if (resource === ".output") resources.promoteOutput(source);
    else resources.promoteNodeModules(source);
    const prefix = `${resource}.iva-backup-`;
    const backup = onlyBackup(fx.root, prefix);
    rmSync(backup, { recursive: true });
    mkdirSync(backup);
    writeFileSync(join(backup, "foreign"), "foreign\n");

    const errors = resources.rollback();

    assert.equal(errors.length, 1);
    assert.equal(readFileSync(join(backup, "foreign"), "utf8"), "foreign\n");
    assert.equal(readFileSync(join(live, "new"), "utf8"), "new\n");
  });

  test(`${resource} cleanup preserves a replacement backup`, (t) => {
    const fx = fixture(t);
    const logFile = join(fx.temp, "cleanup.log");
    const live = join(fx.root, resource);
    const source = join(fx.temp, `${resource.slice(1)}-source`);
    mkdirSync(live);
    writeFileSync(join(live, "old"), "old\n");
    mkdirSync(source);
    writeFileSync(join(source, "new"), "new\n");
    const resources = owner(fx, logFile);
    if (resource === ".output") resources.promoteOutput(source);
    else resources.promoteNodeModules(source);
    const backup = onlyBackup(fx.root, `${resource}.iva-backup-`);
    rmSync(backup, { recursive: true });
    mkdirSync(backup);
    writeFileSync(join(backup, "foreign"), "foreign\n");

    resources.cleanup();

    assert.equal(readFileSync(join(backup, "foreign"), "utf8"), "foreign\n");
    assert.match(readFileSync(logFile, "utf8"), /ownership changed/u);
  });
}

test("a changed live descendant preserves output and makes rollback incomplete", (t) => {
  const fx = fixture(t);
  const live = join(fx.root, ".output");
  const source = join(fx.temp, "output-source");
  mkdirSync(live);
  writeFileSync(join(live, "old"), "old\n");
  mkdirSync(source);
  writeFileSync(join(source, "owned"), "owned\n");
  const resources = owner(fx);
  resources.promoteOutput(source);
  writeFileSync(join(live, "owned"), "foreign\n");

  const errors = resources.rollback();

  assert.equal(errors.length, 1);
  assert.equal(readFileSync(join(live, "owned"), "utf8"), "foreign\n");
  assert.equal(existsSync(onlyBackup(fx.root, ".output.iva-backup-")), true);
});

test("a removed backup descendant retains node_modules cleanup debt", (t) => {
  const fx = fixture(t);
  const logFile = join(fx.temp, "cleanup.log");
  const live = join(fx.root, "node_modules");
  const source = join(fx.temp, "node-modules-source");
  mkdirSync(live);
  writeFileSync(join(live, "old"), "old\n");
  mkdirSync(source);
  writeFileSync(join(source, "new"), "new\n");
  const resources = owner(fx, logFile);
  resources.promoteNodeModules(source);
  const backup = join(onlyBackup(fx.root, "node_modules.iva-backup-"), "owned");
  rmSync(join(backup, "old"));

  resources.cleanup();

  assert.equal(existsSync(backup), true);
  assert.equal(existsSync(join(backup, "old")), false);
  assert.match(readFileSync(logFile, "utf8"), /ownership changed/u);
});

test("replacement after live precheck is restored from quarantine", (t) => {
  const fx = fixture(t);
  const live = join(fx.root, ".output");
  const source = join(fx.temp, "output-source");
  mkdirSync(live);
  writeFileSync(join(live, "old"), "old\n");
  mkdirSync(source);
  writeFileSync(join(source, "new"), "new\n");
  let replace = false;
  const resources = owner(fx, undefined, {
    beforeQuarantineRename(path) {
      if (!replace || path !== live) return;
      replace = false;
      rmSync(live, { recursive: true });
      mkdirSync(live);
      writeFileSync(join(live, "foreign"), "foreign\n");
    },
  });
  resources.promoteOutput(source);
  replace = true;

  const errors = resources.rollback();

  assert.equal(errors.length, 1);
  assert.equal(readFileSync(join(live, "foreign"), "utf8"), "foreign\n");
  assert.deepEqual(
    readdirSync(fx.root).filter((name) => name.includes("iva-remove")),
    [],
  );
});
