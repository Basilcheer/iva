import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quarantineDir } from "./wf-store.mjs";

test("quarantineDir переименовывает стор в *.trash-<штамп> с содержимым", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-"));
  const dir = join(root, ".workflow-data");
  mkdirSync(dir);
  writeFileSync(join(dir, "run.json"), "{}");
  const dest = quarantineDir(dir, "2026-01-01T00-00-00-000Z");
  assert.equal(dest, `${dir}.trash-2026-01-01T00-00-00-000Z`);
  assert.ok(!existsSync(dir), "исходная директория должна исчезнуть");
  assert.ok(existsSync(join(dest, "run.json")), "содержимое должно переехать в карантин");
});

test("quarantineDir на отсутствующей директории — null, ничего не создаёт", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-"));
  const dir = join(root, ".workflow-data");
  assert.equal(quarantineDir(dir), null);
  assert.deepEqual(readdirSync(root), []);
});

test("старые карантины ротируются, свежие остаются", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-"));
  const dir = join(root, "store");
  for (const stamp of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
    mkdirSync(dir);
    quarantineDir(dir, stamp);
  }
  assert.deepEqual(readdirSync(root).sort(), ["store.trash-2026-01-02", "store.trash-2026-01-03"]);
});
