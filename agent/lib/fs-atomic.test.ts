/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns test registration. */
// Враждебные тесты двух примитивов долговечности (ADR-0002): запись, которую нельзя
// увидеть наполовину, и лок, который нельзя увести у живого держателя. Проверяются
// сценарии отказа, а не happy path: убитый посреди записи процесс, гонка двух писателей,
// протухший лок, смерть под локом, чтение параллельно с записью.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireFileLock,
  acquireFileLockSync,
  releaseFileLock,
  writeFileAtomic,
  writeFileAtomicSync,
} from "./fs-atomic.ts";

const MODULE_URL = pathToFileURL(
  fileURLToPath(new URL("./fs-atomic.ts", import.meta.url)),
).href;

const workspace = (): string => mkdtempSync(join(tmpdir(), "iva-fs-atomic-"));

const tmpLeftovers = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.includes(".tmp-"));

// Дочерний процесс пишет в тот же файл настоящим примитивом: половина сценариев
// (SIGKILL посреди записи, лок мёртвого держателя) внутри одного процесса не
// воспроизводится вообще.
async function startChild(
  source: string,
  args: string[],
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, ...args],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  assert.ok(child.stdout);
  await once(child.stdout, "data"); // "ready": ребёнок дошёл до рабочего цикла
  return child;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── атомарная запись ──────────────────────────────────────────────────────

test("запись целиком заменяет файл и не оставляет tmp — sync и async", async () => {
  const dir = workspace();
  const file = join(dir, "nested", "store.json");

  writeFileAtomicSync(file, "первая\n");
  assert.equal(readFileSync(file, "utf8"), "первая\n");
  await writeFileAtomic(file, "вторая\n");
  assert.equal(readFileSync(file, "utf8"), "вторая\n");

  assert.deepEqual(tmpLeftovers(join(dir, "nested")), []);
  assert.deepEqual(readdirSync(join(dir, "nested")), ["store.json"]);
});

test("mode применяется к создаваемому файлу", () => {
  const dir = workspace();
  const file = join(dir, "secret.json");
  writeFileAtomicSync(file, "{}", { mode: 0o600 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("сбой rename убирает tmp и пробрасывает ошибку, не трогая цель", async () => {
  const dir = workspace();
  // Цель — каталог: rename на него обязан упасть, а старые данные (сам каталог с
  // его содержимым) остаться нетронутыми.
  const file = join(dir, "occupied");
  mkdirSync(join(file, "inside"), { recursive: true });

  assert.throws(() => {
    writeFileAtomicSync(file, "новое");
  });
  await assert.rejects(() => writeFileAtomic(file, "новое"));

  assert.deepEqual(readdirSync(file), ["inside"]);
  assert.deepEqual(tmpLeftovers(dir), [], "tmp обязан быть убран после сбоя");
});

test("восемь параллельных писателей не делят tmp: побеждает один, мусора нет", async () => {
  const dir = workspace();
  const file = join(dir, "contended.json");
  const payloads = Array.from({ length: 8 }, (_, i) => `writer-${i}`);

  await Promise.all(payloads.map((payload) => writeFileAtomic(file, payload)));

  assert.ok(payloads.includes(readFileSync(file, "utf8")));
  assert.deepEqual(readdirSync(dir), ["contended.json"]);
});

test("убитый посреди записи писатель не оставляет полфайла — читатель видит только целые версии (seed виден)", async (t) => {
  const seed = Number(process.env.IVA_TEST_SEED ?? Date.now() % 100_000);
  console.log(`fs-atomic partial-write seed: ${seed} (IVA_TEST_SEED to replay)`);
  let lcg = seed >>> 0;
  const nextDelay = (): number => {
    lcg = (lcg * 1_664_525 + 1_013_904_223) >>> 0;
    return 5 + (lcg % 120);
  };

  const dir = workspace();
  const file = join(dir, "big.json");
  const size = 512 * 1024;
  const before = "A".repeat(size);
  const after = "B".repeat(size);
  writeFileAtomicSync(file, before);

  const source = [
    `import { writeFileAtomicSync } from ${JSON.stringify(MODULE_URL)};`,
    "const [file, size] = process.argv.slice(1);",
    'const payload = "B".repeat(Number(size));',
    'process.stdout.write("ready\\n");',
    "for (;;) writeFileAtomicSync(file, payload);",
  ].join("\n");

  for (let round = 0; round < 4; round++) {
    const child = await startChild(source, [file, String(size)]);
    t.after(() => child.kill("SIGKILL"));
    // Читатель работает параллельно с писателем: каждая прочитанная версия обязана
    // быть целой, «полкарточки» не существует ни в одном кадре.
    const deadline = Date.now() + nextDelay();
    while (Date.now() < deadline) {
      const seen = readFileSync(file, "utf8");
      assert.ok(
        seen === before || seen === after,
        `seed ${seed} round ${round}: читатель увидел ${seen.length} байт`,
      );
    }
    child.kill("SIGKILL");
    await once(child, "exit");

    const survived = readFileSync(file, "utf8");
    assert.ok(
      survived === before || survived === after,
      `seed ${seed} round ${round}: после SIGKILL в файле ${survived.length} байт`,
    );
  }
});

// ─── лок ───────────────────────────────────────────────────────────────────

test("лок эксклюзивен: проигравший получает null в пределах таймаута, победитель — держатель", async () => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");

  const held = acquireFileLockSync(path, { timeoutMs: 500 });
  assert.ok(held);
  const started = Date.now();
  assert.equal(await acquireFileLock(path, { timeoutMs: 100, retryMs: 5 }), null);
  assert.equal(acquireFileLockSync(path, { timeoutMs: 100, retryMs: 5 }), null);
  assert.ok(Date.now() - started >= 100, "проигравший обязан реально ждать");

  releaseFileLock(held);
  const next = await acquireFileLock(path, { timeoutMs: 100 });
  assert.ok(next);
  releaseFileLock(next);
  assert.equal(existsSync(path), false);
});

test("лок создаёт недостающий каталог данных", () => {
  const dir = workspace();
  const path = join(dir, "data", "tasks.json.lock");
  const held = acquireFileLockSync(path, { timeoutMs: 100 });
  assert.ok(held);
  releaseFileLock(held);
});

test("протухший лок отбирается, свежий — нет", () => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");
  writeFileSync(path, "dead-owner");

  assert.equal(
    acquireFileLockSync(path, { timeoutMs: 60, staleMs: 60_000, retryMs: 5 }),
    null,
    "свежий чужой лок неприкосновенен",
  );

  const past = new Date(Date.now() - 31_000);
  utimesSync(path, past, past);
  const stolen = acquireFileLockSync(path, { timeoutMs: 60, staleMs: 30_000 });
  assert.ok(stolen, "протухший лок обязан быть отобран");
  releaseFileLock(stolen);
});

test("держатель, убитый под локом, блокирует до протухания и не дальше", async (t) => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");
  const source = [
    `import { acquireFileLockSync } from ${JSON.stringify(MODULE_URL)};`,
    "const [path] = process.argv.slice(1);",
    "acquireFileLockSync(path, { timeoutMs: 1000 });",
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");

  const child = await startChild(source, [path]);
  t.after(() => child.kill("SIGKILL"));
  child.kill("SIGKILL");
  await once(child, "exit");

  assert.ok(existsSync(path), "лок мёртвого держателя остаётся на диске");
  assert.equal(
    await acquireFileLock(path, { timeoutMs: 60, staleMs: 60_000, retryMs: 5 }),
    null,
    "пока лок не протух, преемник ждёт",
  );

  await sleep(60);
  const successor = await acquireFileLock(path, {
    timeoutMs: 200,
    staleMs: 50,
    retryMs: 5,
  });
  assert.ok(successor, "протухший лок мёртвого держателя обязан быть отобран");
  releaseFileLock(successor);
});

test("release снимает только свой лок: запоздавший держатель не трогает преемника", () => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");

  const evicted = acquireFileLockSync(path, { timeoutMs: 100 });
  assert.ok(evicted);
  const past = new Date(Date.now() - 31_000);
  utimesSync(path, past, past);
  const successor = acquireFileLockSync(path, {
    timeoutMs: 100,
    staleMs: 30_000,
  });
  assert.ok(successor);
  assert.notEqual(evicted.token, successor.token);

  releaseFileLock(evicted); // запоздавший release вытесненного держателя
  assert.equal(existsSync(path), true, "лок преемника обязан остаться");
  releaseFileLock(successor);
  assert.equal(existsSync(path), false);
  releaseFileLock(successor); // повторный release уже снятого лока — не ошибка
});

test("мигающий чужой лок не зацикливает захват: дедлайн действует и на пути «лок исчез»", async (t) => {
  const dir = workspace();
  const path = join(dir, "store.json.lock");
  const source = [
    "import { rmSync, writeFileSync } from 'node:fs';",
    "const [path] = process.argv.slice(1);",
    'process.stdout.write("ready\\n");',
    "const stop = Date.now() + 3000;",
    "while (Date.now() < stop) {",
    "  try { writeFileSync(path, 'blink', { flag: 'wx' }); } catch {}",
    "  rmSync(path, { force: true });",
    "}",
  ].join("\n");

  const child = await startChild(source, [path]);
  t.after(() => child.kill("SIGKILL"));

  const started = Date.now();
  const result = acquireFileLockSync(path, {
    timeoutMs: 100,
    staleMs: 60_000,
    retryMs: 5,
  });
  const elapsed = Date.now() - started;
  child.kill("SIGKILL");
  await once(child, "exit");

  if (result) releaseFileLock(result);
  assert.ok(elapsed < 3_000, `захват завис на ${elapsed}ms вместо дедлайна`);
});
