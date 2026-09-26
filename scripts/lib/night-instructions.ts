// Правила ночи идут в промпт текстом, а не путём. Модель звала read_file путём от корня
// проекта, а read_file резолвит такой путь от vault (и намеренно не выходит за него): в
// версионной раскладке это ENOENT, ночь работала без скилла и не ставила отметку конца дня
// (#249). Каждый файл идёт разделом `### Rules: <имя>`, тексты ссылаются на разделы по имени.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type NightPeriod = "daily" | "weekly" | "monthly" | "yearly";

export const INSTRUCTIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "memory",
  "instructions",
);

// Дневной набор — скилл, его фазы и справочники, на которые они ссылаются, плюс правила
// дня и CORE. Прочие ночи несут только своё правило формата.
const SETS: Readonly<Record<NightPeriod, readonly string[]>> = {
  daily: [
    "memory-processor/SKILL.md",
    "memory-processor/phases/capture.md",
    "memory-processor/phases/process.md",
    "memory-processor/phases/link.md",
    "memory-processor/phases/summarize.md",
    "memory-processor/references/classification.md",
    "memory-processor/references/card-templates.md",
    "memory-processor/references/linking.md",
    "rules/daily-format.md",
    "rules/core-format.md",
  ],
  weekly: ["rules/weekly-reflection.md"],
  monthly: ["rules/monthly-format.md"],
  yearly: ["rules/yearly-format.md"],
};

export function nightInstructionFiles(period: NightPeriod): readonly string[] {
  return SETS[period];
}

/** Имя раздела: файл без каталога и .md; SKILL.md называется по своему скиллу. */
export const sectionName = (file: string): string =>
  file.endsWith("/SKILL.md") ? basename(dirname(file)) : basename(file, ".md");

function readInstruction(dir: string, name: string): string {
  let text: string;
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch (error) {
    throw new Error(
      `night instructions: cannot read ${name} in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  // Frontmatter — метаданные для загрузчика скиллов, ночи он не нужен.
  const body = text.replace(/^---\n[\s\S]*?\n---\n/u, "").trim();
  if (!body) throw new Error(`night instructions: ${name} in ${dir} is empty`);
  return body;
}

/** Все правила ночи одной строкой; нет файла или он пуст — ошибка с его именем. */
export function nightInstructions(
  period: NightPeriod,
  dir: string = INSTRUCTIONS_DIR,
): string {
  return SETS[period]
    .map(
      (name) =>
        `### Rules: ${sectionName(name)}\n\n${readInstruction(dir, name)}`,
    )
    .join("\n\n");
}
