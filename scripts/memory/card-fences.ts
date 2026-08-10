// Ночная проверка карточек на незакрытый кодовый фенс. Живёт в scripts/memory/, а не в
// scripts/lib/memory-maintenance.ts: разметку она берёт из authored tree (#lib/card-text.ts),
// а memory-maintenance грузится `iva doctor` на инсталле, где каталога agent/ может не быть
// вовсе. Единственный потребитель — scripts/memory/doctor.ts, и тянет он этот модуль
// динамическим импортом: его ночной юнит обязан загружаться без authored tree, чтобы бэкап
// vault прошёл и на половинчатом дереве.
import { readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { hasUnclosedFence, splitCard } from "#lib/card-text.ts";

/**
 * Карточки с незакрытым кодовым фенсом: их ## History и ## Log читаются как код, поэтому
 * write_card отказывает такой карточке в UPDATE и SUPERSEDE. Только перечисление - чинит
 * фенс человек: догадаться, где автор хотел закрыть блок, машине нечем, а закрыть его
 * наугад значит переписать чужой текст.
 */
export function scanUnclosedFenceCards(vaultPath: string): string[] {
  // Только cards/: write_card пишет карточки туда и больше никуда, а фенс в сыром
  // транскрипте daily/ ничему не мешает - ночной алерт про него был бы ложным.
  const root = resolve(vaultPath, "cards");
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort()) {
    const path = entry.split(sep).join("/");
    // Служебные каталоги (.git, .graph, .obsidian) - не карточки пользователя.
    if (!path.endsWith(".md") || path.split("/").some((p) => p.startsWith(".")))
      continue;
    let text: string;
    try {
      text = readFileSync(resolve(root, entry), "utf8");
    } catch {
      continue; // исчез между листингом и чтением - следующий ночной прогон увидит
    }
    if (hasUnclosedFence(splitCard(text).body)) found.push(`cards/${path}`);
  }
  return found;
}
