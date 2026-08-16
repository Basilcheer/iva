// Скиллы пользователя, прочитанные с диска на ходу.
//
// Встроенные скиллы вкомпилированы в бандл при сборке, поэтому новый файл в
// data/custom/agent/skills/ раньше требовал `iva update`. Этот резолвер читает каталог
// на событии хода, и скилл, созданный минуту назад, работает со следующего хода.
//
// Тонкая обёртка: вся работа с файлами — в agent/lib/custom-skills.ts, здесь только
// контракт eve. Имена в карте бьются с именами встроенных скиллов по правилу eve —
// динамический скилл перекрывает одноимённый встроенный.
import { defineDynamic, defineSkill } from "eve/skills";
import { customSkillsDir, readCustomSkills } from "../lib/custom-skills.ts";

export default defineDynamic({
  events: {
    "turn.started": async () => {
      const skills = await readCustomSkills(customSkillsDir());
      const entries = Object.entries(skills);
      if (entries.length === 0) return null; // ничего не добавляем
      return Object.fromEntries(
        entries.map(([name, skill]) => [name, defineSkill(skill)]),
      );
    },
  },
});
