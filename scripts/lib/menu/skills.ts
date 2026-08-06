// Экран скиллов: read-only список из .eve/agent-summary.json (skills[] {name, description}),
// по 8 на страницу. Файл — продукт сборки eve; путь от deps.root (корень репо). В worktree
// его может не быть — тогда честный текст, а не пустой экран. Пагинацию (pg) двигает движок.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PER_PAGE = 8;

interface MenuButton {
  text: string;
  callback_data: string;
}

interface SkillsContext {
  deps: { root: string };
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => MenuButton;
  backRow: (screenId: string) => MenuButton[];
}

interface SkillsState {
  page?: number;
}

interface Skill {
  name?: unknown;
  description?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function skillFrom(value: unknown): Skill {
  return isRecord(value) ? value : {};
}

function displayText(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- JSON values retain the JavaScript screen's original String coercion.
  return String(value);
}

export default {
  parent: "r",
  render(st: SkillsState, ctx: SkillsContext) {
    const T = ctx.tr;
    let skills: unknown[] | null;
    try {
      const data: unknown = JSON.parse(
        readFileSync(join(ctx.deps.root, ".eve/agent-summary.json"), "utf8"),
      );
      const candidate = isRecord(data) ? data.skills : undefined;
      skills = Array.isArray(candidate) ? candidate : [];
    } catch {
      skills = null; // файла нет / битый — отличаем от «список пуст»
    }
    if (skills === null) {
      return {
        text: T(
          "🧩 Skills\n\nSkill list is unavailable — .eve/agent-summary.json not found (it appears after a build).",
          "🧩 Скиллы\n\nСписок недоступен — .eve/agent-summary.json не найден (появляется после сборки).",
        ),
        rows: [ctx.backRow("r")],
      };
    }
    if (skills.length === 0) {
      return {
        text: T(
          "🧩 Skills\n\nNo skills registered.",
          "🧩 Скиллы\n\nСкиллов не зарегистрировано.",
        ),
        rows: [ctx.backRow("r")],
      };
    }
    const pages = Math.ceil(skills.length / PER_PAGE);
    const page = Math.min(Math.max(st.page || 0, 0), pages - 1);
    st.page = page;
    const body = skills
      .slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
      .map((value) => {
        const skill = skillFrom(value);
        const name = displayText(skill.name, "?");
        const desc = displayText(skill.description, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
        return `• ${name}${desc ? ` — ${desc}` : ""}`;
      })
      .join("\n");
    const rows: MenuButton[][] = [];
    if (pages > 1) {
      rows.push([
        ctx.btn("‹", `iva_menu:sk:pg:${page > 0 ? page - 1 : 0}`),
        ctx.btn(`${page + 1}/${pages}`, `iva_menu:sk:pg:${page}`),
        ctx.btn(
          "›",
          `iva_menu:sk:pg:${page < pages - 1 ? page + 1 : pages - 1}`,
        ),
      ]);
    }
    rows.push(ctx.backRow("r"));
    return {
      text: `${T(`🧩 Skills (${skills.length})`, `🧩 Скиллы (${skills.length})`)}\n\n${body}`,
      rows,
    };
  },
  on(...args: unknown[]) {
    void args;
  },
};
