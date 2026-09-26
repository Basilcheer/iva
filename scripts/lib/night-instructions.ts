// Правила ночи идут в промпт текстом, а не путём. В версионной раскладке путь к
// scripts/memory/instructions/ лежит вне vault, и read_file (он берёт путь от корня vault и
// намеренно не выходит за него) отдавал ENOENT: ночь работала без скилла и не ставила
// отметку конца дня (#249). Каждый файл идёт под заголовком `### <имя от instructions/>`,
// и ссылки внутри текстов называют эти разделы, а не пути.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    "memory-processor/references/daily-summary.md",
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

function readInstruction(dir: string, name: string): string {
  try {
    return readFileSync(join(dir, name), "utf8").trim();
  } catch (error) {
    throw new Error(
      `night instructions: cannot read ${name} in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Все правила ночи одной строкой; нет файла — ошибка с его именем, а не тихий пропуск. */
export function nightInstructions(
  period: NightPeriod,
  dir: string = INSTRUCTIONS_DIR,
): string {
  return SETS[period]
    .map((name) => `### ${name}\n\n${readInstruction(dir, name)}`)
    .join("\n\n");
}
