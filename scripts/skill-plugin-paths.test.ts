// Команда установки черновика в скиллах — локальный путь. Путь без «./» парсер читает как
// owner/repo на GitHub: `iva plugin add data/custom/...` ушёл бы клонировать github.com/data/custom,
// и сверка черновика с сообщением Insight (ADR-0022) на нём не срабатывает.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePluginSource } from "./lib/plugin-source.ts";

const SKILLS = join(import.meta.dirname, "..", "agent", "skills");

// Файл вне пакетов волны 2: правка ждёт решения лида (verdict-w2.md).
const PENDING = new Set(["make-plugin"]);

/** Аргументы `iva plugin add <путь к черновику>` из текста скилла (перенос строки — пробел). */
function draftAdds(text: string): string[] {
  const flat = text.replace(/\s+/gu, " ");
  return [...flat.matchAll(/iva plugin add (\S*plugin-drafts\S*)/gu)].map(
    (match) => match[1].replace(/[`'".,;)]+$/u, ""),
  );
}

for (const skill of readdirSync(SKILLS, { withFileTypes: true })) {
  if (!skill.isDirectory()) continue;
  let text: string;
  try {
    text = readFileSync(join(SKILLS, skill.name, "SKILL.md"), "utf8");
  } catch {
    continue;
  }
  const adds = draftAdds(text);
  if (adds.length === 0) continue;
  void test(
    `skill ${skill.name}: every iva plugin add of a draft is a local path`,
    { todo: PENDING.has(skill.name) ? "file outside wave 2" : undefined },
    () => {
      // Модель подставляет имя черновика вместо <name>.
      for (const raw of adds) {
        const typed = raw.replace("<name>", "rain-alert");
        assert.equal(parsePluginSource(typed).kind, "local", typed);
      }
    },
  );
}
