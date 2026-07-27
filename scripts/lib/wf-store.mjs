// Карантин вместо необратимого rm для стора воркфлоу eve: rename в соседний
// *.trash-<штамп> (атомарно в пределах одной ФС) с ротацией старых карантинов.
// Даёт откат после случайного reset: припаркованные диалоги возвращаются обратным
// переименованием, пока карантин не вытеснен ротацией.
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const TRASH_KEEP = 2;

// dir → dir.trash-<stamp>. Возвращает путь карантина или null, если dir не существует.
export function quarantineDir(dir, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  if (!existsSync(dir)) return null;
  const dest = `${dir}.trash-${stamp}`;
  renameSync(dir, dest);
  pruneTrash(dir);
  return dest;
}

// Оставляет keep свежих карантинов dir (ISO-штампы сортируются лексикографически = хронологически).
export function pruneTrash(dir, keep = TRASH_KEEP) {
  const prefix = `${basename(dir)}.trash-`;
  let names;
  try {
    names = readdirSync(dirname(dir)).filter((n) => n.startsWith(prefix)).sort();
  } catch {
    return;
  }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(dirname(dir), n), { recursive: true, force: true });
  }
}
