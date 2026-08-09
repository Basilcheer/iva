// Карантин вместо необратимого rm для reset-состояния: rename в соседний
// *.trash-<штамп> (атомарно в пределах одной ФС) с ротацией старых карантинов.
// Даёт откат после случайного reset: припаркованные диалоги возвращаются обратным
// переименованием, пока карантин не вытеснен ротацией.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const TRASH_KEEP = 2;

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === code;
}

function pathStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

// Куда путь ведёт на самом деле. В версионном layout стор внутри версии — симлинк на
// стор установки: переименовать саму ссылку значит оставить состояние жить (и вернуть
// его следующим апдейтом, который перелинкует версию на тот же каталог).
function throughLink(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink()
      ? resolve(dirname(path), readlinkSync(path))
      : path;
  } catch {
    return path;
  }
}

// file/dir → path.trash-<stamp>. Одна операция reset передаёт общий stamp; если такой
// карантин уже есть, суффикс не даёт затереть предыдущую копию.
export function quarantinePath(
  link: string,
  stamp = new Date().toISOString().replace(/[:.]/g, "-"),
): string | null {
  const path = throughLink(link);
  const stat = pathStat(path);
  if (!stat) return null;
  const base = `${path}.trash-${stamp}`;
  let dest = base;
  for (let collision = 1; pathStat(dest); collision++)
    dest = `${base}-${collision}`;

  // Права едут вместе с inode после rename. Закрываем источник заранее: при сбое chmod
  // исходник остаётся на месте, а вызывающий reset честно отмечает incomplete.
  if (stat.isDirectory()) chmodSync(path, 0o700);
  else if (stat.isFile()) chmodSync(path, 0o600);
  renameSync(path, dest);
  // Ссылка не должна повиснуть: mkdir через висящий симлинк — ENOENT, и сервис,
  // который сам создаёт свой стор при старте, после reset уже не поднимется.
  if (path !== link && stat.isDirectory())
    mkdirSync(path, { recursive: true, mode: 0o700 });
  pruneTrash(path);
  return dest;
}

// Старое имя остаётся публичным alias для существующих вызовов и тестов.
export function quarantineDir(dir: string, stamp?: string): string | null {
  return quarantinePath(dir, stamp);
}

// Полный reset должен атомарно вывести из обращения и workflow, и Telegram control state.
export function resetStateTargets(root: string, dataDir: string): string[] {
  return [
    join(root, ".eve", ".workflow-data"),
    join(root, ".workflow-data"),
    join(dataDir, "run-status.d"),
    join(dataDir, "run-status.json"),
    join(dataDir, "telegram-queue.json"),
  ];
}

// Оставляет keep свежих карантинов path (ISO-штампы сортируются лексикографически).
export function pruneTrash(path: string, keep = TRASH_KEEP): void {
  const prefix = `${basename(path)}.trash-`;
  let names: string[];
  try {
    names = readdirSync(dirname(path))
      .filter((name) => name.startsWith(prefix))
      .sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(dirname(path), name), { recursive: true, force: true });
  }
}
