// Два примитива, на которых держится ADR-0002 («данные пользователя не теряются»):
// запись через уникальный tmp + rename — читатель никогда не видит половину файла, и
// лок-файл O_EXCL с токеном владения — параллельные писатели (агент, мост, спавнер
// расписаний) сериализуются, а release снимает лок, только пока на диске наш токен.
//
// Оба примитива есть в sync- и async-варианте, потому что это разные семантики, а не
// удобство: sync-держатель крутится на Atomics.wait и обязан быть sync (write_card,
// run-status вызываются из синхронного кода), а async-держатель обязан отпускать
// event loop — иначе два конкурирующих хода в одном процессе (инструмент tasks,
// спавнер расписаний) сами себя загнали бы в дедлок до таймаута.
//
// Политика (сколько ждать, когда считать лок протухшим, каким режимом создавать файл)
// принадлежит вызывающему: у карточки вольта, статуса хода и резервации расписания
// разные цены ожидания. Здесь только механизм.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type AtomicWriteOptions = {
  /** Права создаваемого файла; по умолчанию — обычный umask-дефолт Node (0o666). */
  mode?: number;
};

export type FileLock = {
  /** Путь самого lock-файла (не защищаемого им файла). */
  path: string;
  /** Токен владения: release сверяет его с содержимым лока на диске. */
  token: string;
};

export type FileLockOptions = {
  /** Сколько ждать освобождения, прежде чем сдаться. */
  timeoutMs?: number;
  /** Возраст лока, после которого он считается брошенным упавшим процессом. */
  staleMs?: number;
  /** Пауза между попытками захвата. */
  retryMs?: number;
  /** Права lock-файла. */
  mode?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 15_000;
const DEFAULT_RETRY_MS = 25;

const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;

// Уникален на процесс И на вызов: два параллельных writeFileAtomic не разделят один
// tmp-путь, а значит не затрут запись друг друга и не выдернут tmp из-под чужого
// rename (ENOENT). Флаг "wx" ниже страхует это на уровне ФС.
const tmpPathFor = (file: string): string =>
  `${file}.tmp-${process.pid}-${randomUUID()}`;

/** Атомарная замена файла: читатель видит либо старое содержимое целиком, либо новое. */
export function writeFileAtomicSync(
  file: string,
  data: string,
  { mode }: AtomicWriteOptions = {},
): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = tmpPathFor(file);
  try {
    writeFileSync(tmp, data, { encoding: "utf8", flag: "wx", mode });
    renameSync(tmp, file);
  } catch (error) {
    // Сбой записи или rename не должен оставлять мусор рядом с данными.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* tmp уже забрал rename или его не удалось создать вовсе */
    }
    throw error;
  }
}

/** То же, что writeFileAtomicSync, но не блокирует event loop. */
export async function writeFileAtomic(
  file: string,
  data: string,
  { mode }: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = tmpPathFor(file);
  try {
    await writeFile(tmp, data, { encoding: "utf8", flag: "wx", mode });
    await rename(tmp, file);
  } catch (error) {
    try {
      await rm(tmp, { force: true });
    } catch {
      /* tmp уже забрал rename или его не удалось создать вовсе */
    }
    throw error;
  }
}

type Attempt = FileLock | "busy" | "retry";

// Одна попытка захвата. "busy" — лок держит кто-то живой (стоит подождать),
// "retry" — лок протух или исчез между попыткой и stat, повторяем немедленно.
function attemptLock(
  path: string,
  staleMs: number,
  mode: number | undefined,
): Attempt {
  const token = randomUUID();
  try {
    const fd = openSync(path, "wx", mode);
    try {
      writeSync(fd, token);
    } catch (error) {
      // Лок создан, но токена в нём нет: снимаем сами, иначе он висел бы до
      // протухания, никому не принадлежа.
      rmSync(path, { force: true });
      throw error;
    } finally {
      closeSync(fd);
    }
    return { path, token };
  } catch (error) {
    // Ретраим только «лок занят»; остальные ошибки open (EACCES, EROFS…) — наружу.
    if (errorCode(error) !== "EEXIST") throw error;
  }
  try {
    if (Date.now() - statSync(path).mtimeMs > staleMs) {
      rmSync(path, { force: true });
      return "retry";
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return "retry";
  }
  return "busy";
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Захват лока без освобождения event loop. Возвращает держателя или null, если
 * таймаут истёк: что значит «не досталось» — ошибка или работа без лока — решает
 * вызывающий, у которого есть слова для своего пользователя.
 */
export function acquireFileLockSync(
  path: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    retryMs = DEFAULT_RETRY_MS,
    mode,
  }: FileLockOptions = {},
): FileLock | null {
  // Свежая установка: каталога данных может ещё не быть — лок не должен падать ENOENT.
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = attemptLock(path, staleMs, mode);
    if (typeof attempt !== "string") return attempt;
    // Дедлайн проверяется и на пути "retry": мигающий чужой лок иначе зациклил бы
    // захват навсегда.
    if (Date.now() > deadline) return null;
    if (attempt === "busy") Atomics.wait(waitBuffer, 0, 0, retryMs);
  }
}

/** То же, что acquireFileLockSync, но ждёт, отпуская event loop. */
export async function acquireFileLock(
  path: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    retryMs = DEFAULT_RETRY_MS,
    mode,
  }: FileLockOptions = {},
): Promise<FileLock | null> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = attemptLock(path, staleMs, mode);
    if (typeof attempt !== "string") return attempt;
    if (Date.now() > deadline) return null;
    if (attempt === "busy")
      await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/**
 * Снятие лока. Вытесненный по протуханию держатель, вернувшийся к жизни, не удалит
 * лок преемника: на диске уже чужой токен.
 */
export function releaseFileLock({ path, token }: FileLock): void {
  try {
    if (readFileSync(path, "utf8") !== token) return;
    rmSync(path, { force: true });
  } catch {
    /* лока уже нет */
  }
}
