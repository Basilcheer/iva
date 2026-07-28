// Карантин вместо необратимого rm для reset-состояния: rename в соседний
// *.trash-<штамп> (атомарно в пределах одной ФС) с ротацией старых карантинов.
// Даёт откат после случайного reset: припаркованные диалоги возвращаются обратным
// переименованием, пока карантин не вытеснен ротацией.
import { chmodSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const TRASH_KEEP = 2;

function pathStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// file/dir → path.trash-<stamp>. Одна операция reset передаёт общий stamp; если такой
// карантин уже есть, суффикс не даёт затереть предыдущую копию.
export function quarantinePath(path, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  const stat = pathStat(path);
  if (!stat) return null;
  const base = `${path}.trash-${stamp}`;
  let dest = base;
  for (let collision = 1; pathStat(dest); collision++) dest = `${base}-${collision}`;

  // Права едут вместе с inode после rename. Закрываем источник заранее: при сбое chmod
  // исходник остаётся на месте, а вызывающий reset честно отмечает incomplete.
  if (stat.isDirectory()) chmodSync(path, 0o700);
  else if (stat.isFile()) chmodSync(path, 0o600);
  renameSync(path, dest);
  pruneTrash(path);
  return dest;
}

// Старое имя остаётся публичным alias для существующих вызовов и тестов.
export function quarantineDir(dir, stamp) {
  return quarantinePath(dir, stamp);
}

// Полный reset должен атомарно вывести из обращения и workflow, и Telegram control state.
export function resetStateTargets(root, dataDir) {
  return [
    join(root, ".eve", ".workflow-data"),
    join(root, ".workflow-data"),
    join(dataDir, "run-status.d"),
    join(dataDir, "run-status.json"),
    join(dataDir, "telegram-queue.json"),
  ];
}

// Оставляет keep свежих карантинов path (ISO-штампы сортируются лексикографически).
export function pruneTrash(path, keep = TRASH_KEEP) {
  const prefix = `${basename(path)}.trash-`;
  let names;
  try {
    names = readdirSync(dirname(path)).filter((n) => n.startsWith(prefix)).sort();
  } catch {
    return;
  }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(dirname(path), n), { recursive: true, force: true });
  }
}
