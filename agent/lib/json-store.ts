// Примитивы надёжного JSON-файла для инструментов агента: лок-файл (O_EXCL) против
// параллельных ходов (расписание + живой чат), атомарная запись (tmp + rename) против
// полуписьма, и честная ошибка парсинга с бэкапом вместо тихого «файла нет».
import { closeSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Лок через O_EXCL-создание файла. Протухший (держатель умер) снимается по возрасту.
export async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      // Ретраим только «лок занят»; остальные ошибки open (EACCES, EROFS…) — наружу.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statErr) {
        // Лок исчез между попыткой и stat — пробуем снова; прочие сбои stat — наружу.
        if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
        continue;
      }
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lockPath}`);
      await sleep(50);
    }
  }
}

export function releaseLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
}

// Читает JSON. Нет файла → fallback. БИТЫЙ файл → бэкап в *.corrupt-<stamp> и ошибка:
// вернуть fallback здесь значило бы молча уничтожить все данные следующим save.
export async function loadJsonStrict<T>(file: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    // fallback — только для «файла нет». EACCES/EIO и прочее — наружу: вернуть пустоту
    // на живых данных значило бы уничтожить их следующим save.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      renameSync(file, backup);
    } catch {
      /* не смогли отложить — всё равно не перезаписываем молча */
    }
    throw new Error(`${file} damaged (invalid JSON) — moved to ${backup}, fix or delete it`);
  }
}

// Атомарная запись: уникальный tmp в той же директории (wx — эксклюзивное создание,
// два параллельных save не разделят один tmp-путь) + rename.
export async function saveJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
  await rename(tmp, file);
}
