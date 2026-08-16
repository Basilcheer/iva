// Примитивы надёжного JSON-файла для инструментов агента: lock-каталог с owner-entry против
// параллельных ходов (расписание + живой чат), атомарная запись (tmp + rename) против
// полуписьма, и честная ошибка парсинга с бэкапом вместо тихого «файла нет».
// Механизм лока и записи живёт в fs-atomic.ts; здесь — политика этих файлов.
import { renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  acquireFileLock,
  releaseFileLock,
  writeFileAtomic,
} from "./fs-atomic.ts";

const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;

// Ожидание асинхронное: расписание и живой чат ходят в один файл из ОДНОГО процесса,
// и синхронное ожидание не дало бы держателю дойти до release — вместо очереди
// получился бы дедлок до таймаута.
export async function acquireLock(lockPath: string): Promise<string> {
  const held = await acquireFileLock(lockPath, {
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
    retryMs: LOCK_RETRY_MS,
  });
  if (held === null) throw new Error(`lock timeout: ${lockPath}`);
  return held.token;
}

export function releaseLock(lockPath: string, token: string): void {
  releaseFileLock({ path: lockPath, token });
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
    throw new Error(
      `${file} damaged (invalid JSON) — moved to ${backup}, fix or delete it`,
    );
  }
}

export async function saveJsonAtomic(
  file: string,
  data: unknown,
): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(data, null, 2));
}
