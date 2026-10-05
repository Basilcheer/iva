// Скиллы пользователя и плагинов, прочитанные с диска на ходу.
//
// Встроенные скиллы вкомпилированы в бандл при сборке, поэтому новый файл в
// data/custom/agent/skills/ раньше требовал `iva update`. Этот резолвер читает диск
// на событии хода, и скилл, созданный минуту назад, работает со следующего хода. Тем
// же путём приходят скиллы включённых плагинов из data/custom/plugins/ (ADR-0009):
// `iva plugin add` не собирает версию и не рестартует агента.
//
// Тонкая обёртка: вся работа с файлами — в agent/lib/custom-skills.ts, здесь только
// контракт eve. Имена в карте бьются с именами встроенных скиллов по правилу eve —
// динамический скилл перекрывает одноимённый встроенный.
import { defineDynamic, defineSkill } from "eve/skills";
import { readLiveSkills, type CustomSkill } from "../lib/custom-skills.ts";

/**
 * Каждая запись проходит `defineSkill` отдельно. Сегодня он только ставит метку, а
 * шапку проверяет сборка, в которую скиллы владельца больше не входят. Если eve начнёт
 * проверять шапку здесь, бросок одной кривой записи иначе унёс бы из хода все живые
 * скиллы, включая скиллы плагинов: такая запись пропускается одной строкой.
 */
export function liveSkillMap(
  skills: Readonly<Record<string, CustomSkill>>,
  define: (skill: CustomSkill) => CustomSkill = defineSkill,
  log: (line: string) => void = console.error,
): Record<string, CustomSkill> {
  const map: Record<string, CustomSkill> = {};
  for (const [name, skill] of Object.entries(skills)) {
    try {
      map[name] = define(skill);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      log(`[skills] ${name} skipped: ${why}`);
    }
  }
  return map;
}

export default defineDynamic({
  events: {
    "turn.started": async () => {
      const skills = liveSkillMap(await readLiveSkills());
      if (Object.keys(skills).length === 0) return null; // ничего не добавляем
      return skills;
    },
  },
});
