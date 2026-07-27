// Тесты примитивов agent/lib/json-store.ts (лок, атомарная запись, бэкап битого JSON).
// Импорт .ts напрямую: Node 24 стрипает типы без флагов при явном .ts-специфкаторе.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, loadJsonStrict, releaseLock, saveJsonAtomic } from "../agent/lib/json-store.ts";

test("нет файла → fallback; save+load round-trip; tmp не остаётся", async () => {
  const dir = mkdtempSync(join(tmpdir(), "json-store-"));
  const file = join(dir, "tasks.json");
  assert.deepEqual(await loadJsonStrict(file, []), []);
  await saveJsonAtomic(file, [{ id: 1 }]);
  assert.deepEqual(await loadJsonStrict(file, []), [{ id: 1 }]);
  assert.deepEqual(readdirSync(dir), ["tasks.json"], "tmp-файл должен быть переименован");
});

test("битый JSON: бэкап *.corrupt-* и явная ошибка, не пустой fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "json-store-"));
  const file = join(dir, "tasks.json");
  writeFileSync(file, "{broken");
  await assert.rejects(() => loadJsonStrict(file, []), /damaged/);
  assert.ok(!existsSync(file), "битый файл должен быть отложен");
  const backup = readdirSync(dir).find((n) => n.startsWith("tasks.json.corrupt-"));
  assert.ok(backup, "должен появиться corrupt-бэкап");
  assert.equal(readFileSync(join(dir, backup), "utf8"), "{broken", "содержимое сохранено");
});

test("лок эксклюзивен, снимается, протухший лок отбирается", async () => {
  const dir = mkdtempSync(join(tmpdir(), "json-store-"));
  const lock = join(dir, "tasks.json.lock");
  await acquireLock(lock);
  await assert.rejects(() => acquireLock(lock), /lock timeout/, "второй захват должен ждать и падать по таймауту");
  releaseLock(lock);
  await acquireLock(lock); // после release захватывается снова
  releaseLock(lock);
});
