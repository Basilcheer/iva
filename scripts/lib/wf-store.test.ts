import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quarantineDir,
  quarantinePath,
  resetStateTargets,
} from "./wf-store.ts";

void test("quarantineDir переименовывает стор в *.trash-<штамп> с содержимым", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-"));
  const dir = join(root, ".workflow-data");
  mkdirSync(dir);
  writeFileSync(join(dir, "run.json"), "{}");
  const dest = quarantineDir(dir, "2026-01-01T00-00-00-000Z");
  assert.equal(dest, `${dir}.trash-2026-01-01T00-00-00-000Z`);
  assert.ok(dest);
  assert.ok(!existsSync(dir), "исходная директория должна исчезнуть");
  assert.ok(
    existsSync(join(dest, "run.json")),
    "содержимое должно переехать в карантин",
  );
  assert.equal(statSync(dest).mode & 0o777, 0o700);
});

void test("quarantinePath сохраняет файл и закрывает его права", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-file-"));
  const file = join(root, "telegram-queue.json");
  writeFileSync(file, '{"chat":["secret"]}');
  chmodSync(file, 0o644);

  const dest = quarantinePath(file, "2026-01-01");

  assert.equal(dest, `${file}.trash-2026-01-01`);
  assert.ok(dest);
  assert.equal(readFileSync(dest, "utf8"), '{"chat":["secret"]}');
  assert.equal(statSync(dest).mode & 0o777, 0o600);
});

void test("quarantinePath на отсутствующем пути — null, ничего не создаёт", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-"));
  const dir = join(root, ".workflow-data");
  assert.equal(quarantinePath(dir), null);
  assert.deepEqual(readdirSync(root), []);
});

void test("старые directory-карантины ротируются, свежие остаются", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-"));
  const dir = join(root, "store");
  for (const stamp of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
    mkdirSync(dir);
    quarantineDir(dir, stamp);
  }
  assert.deepEqual(readdirSync(root).sort(), [
    "store.trash-2026-01-02",
    "store.trash-2026-01-03",
  ]);
});

void test("старые file-карантины ротируются по тому же правилу", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-file-"));
  const file = join(root, "run-status.json");
  for (const stamp of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
    writeFileSync(file, stamp);
    quarantinePath(file, stamp);
  }
  assert.deepEqual(readdirSync(root).sort(), [
    "run-status.json.trash-2026-01-02",
    "run-status.json.trash-2026-01-03",
  ]);
});

void test("одинаковый operation stamp не перезаписывает существующий карантин", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-collision-"));
  const file = join(root, "telegram-queue.json");
  writeFileSync(file, "first");
  const first = quarantinePath(file, "same-stamp");
  writeFileSync(file, "second");
  const second = quarantinePath(file, "same-stamp");

  assert.equal(first, `${file}.trash-same-stamp`);
  assert.equal(second, `${file}.trash-same-stamp-1`);
  assert.ok(first);
  assert.ok(second);
  assert.equal(readFileSync(first, "utf8"), "first");
  assert.equal(readFileSync(second, "utf8"), "second");
});

void test("global reset plan includes workflow and all Telegram control-state targets", () => {
  const root = "/srv/iva";
  const data = "/var/lib/iva";
  assert.deepEqual(resetStateTargets(root, data), [
    "/srv/iva/.eve/.workflow-data",
    "/srv/iva/.workflow-data",
    "/var/lib/iva/run-status.d",
    "/var/lib/iva/run-status.json",
    "/var/lib/iva/telegram-queue.json",
  ]);
});
