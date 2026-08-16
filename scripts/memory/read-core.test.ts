import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCore } from "./read-core.ts";

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "iva-read-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

void test("a missing CORE is the supported empty first-run state", async (t) => {
  const vault = await sandbox(t);
  writeFileSync(join(vault, "personal.md"), "keep\n", "utf8");
  const path = join(vault, "CORE.md");

  assert.deepEqual(readCore(path), { state: "missing" });
  assert.equal(existsSync(path), false);
});

void test("an empty CORE is valid and stays distinct from missing", async (t) => {
  const vault = await sandbox(t);
  const path = join(vault, "CORE.md");
  writeFileSync(path, "", "utf8");

  assert.deepEqual(readCore(path), { state: "valid", text: "" });
});

void test("a valid CORE preserves its text byte-for-byte", async (t) => {
  const vault = await sandbox(t);
  const path = join(vault, "CORE.md");
  writeFileSync(path, "# CORE\n\n- Сергей\n", "utf8");

  assert.deepEqual(readCore(path), {
    state: "valid",
    text: "# CORE\n\n- Сергей\n",
  });
});

void test("a dangling CORE symlink is unreadable, not missing", async (t) => {
  const vault = await sandbox(t);
  const path = join(vault, "CORE.md");
  symlinkSync(join(vault, "absent-target.md"), path);

  const result = readCore(path);
  assert.equal(result.state, "unreadable");
  if (result.state === "unreadable") {
    assert.equal((result.error as NodeJS.ErrnoException).code, "ENOENT");
  }
});

void test("a CORE path that is a directory is unreadable", async (t) => {
  const vault = await sandbox(t);
  const path = join(vault, "CORE.md");
  mkdirSync(path);

  const result = readCore(path);
  assert.equal(result.state, "unreadable");
  if (result.state === "unreadable") {
    assert.notEqual((result.error as NodeJS.ErrnoException).code, "ENOENT");
  }
});

void test("a permission failure stays unreadable", async (t) => {
  const vault = await sandbox(t);
  const path = join(vault, "CORE.md");
  writeFileSync(path, "private\n", "utf8");
  chmodSync(path, 0o000);
  try {
    const result = readCore(path);
    assert.equal(result.state, "unreadable");
    if (result.state === "unreadable") {
      assert.equal((result.error as NodeJS.ErrnoException).code, "EACCES");
    }
  } finally {
    chmodSync(path, 0o600);
  }
});
