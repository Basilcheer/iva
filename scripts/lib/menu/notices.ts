// Экран «🔔 Уведомления»: чем Iva имеет право прервать день. Тумблеры только у Report'ов —
// плановых сводок; алерты (проблемы и предложения обновиться) не выключаются, о чём экран
// говорит прямым текстом (ADR-0007).
//
// Тумблер пишется в data/settings.json, который и rollup, и schedule дайджеста, и тик Watch
// читают в момент запуска — переключение применяется без рестарта процессов. «Сама пишет»
// (Watch и Brief, ADR-0020) включён без ключа и выключает их, но не сообщения о сбоях.
//
// Правило репо: ни одной module-level const с переведённой строкой — подписи собираются в
// render() через ctx.tr, иначе язык замёрзнет до рестарта.
import { parseProactive } from "#lib/proactive-config.ts";
import { readSettings, updateSettings } from "#lib/settings.ts";
import { memoryReportsEnabled } from "../notice-policy.ts";
import { button } from "./buttons.ts";

const PARENT = "r";

type MenuState = { page: number };
type MenuContext = {
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screen: string) => Promise<void>;
};

// Целевой тумблер → ключ в settings.json. Аргумент callback_data — короткий ASCII-энум
// (грамматика в index.ts), а не имя ключа: мусорный аргумент просто не найдёт цели.
const TOGGLES = {
  rep: "memoryReports",
  dig: "digestSchedule",
  pro: "proactive",
} as const;
type Toggle = keyof typeof TOGGLES;

function isToggle(value: string): value is Toggle {
  return Object.hasOwn(TOGGLES, value);
}

function digestEnabled(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const digest = (settings as { digestSchedule?: unknown }).digestSchedule;
  if (typeof digest !== "object" || digest === null) return false;
  return (digest as { enabled?: unknown }).enabled === true;
}

export default {
  parent: PARENT,
  render(_state: MenuState, ctx: MenuContext) {
    const settings = readSettings();
    const T = ctx.tr;
    // Кнопка несёт значение, которое надо получить, а не «переключи»: повторный тап по
    // протухшему меню приводит к тому же состоянию, а не мигает туда-обратно.
    const toggle = (on: boolean, label: string, target: Toggle, what: string) =>
      `${button(
        `${on ? "✓" : "○"} ${label}`,
        `iva_menu:ntc:set:${target}:${on ? "0" : "1"}`,
      )} — ${what}`;
    const text = [
      `# ${T("🔔 Notices", "🔔 Уведомления")}`,
      T(
        "Memory reports: what Iva filed overnight and over the week.\n" +
          "Morning digest: your day ahead at 08:00.",
        "Отчёты памяти: что Ива разложила за ночь и за неделю.\n" +
          "Утренний дайджест: план дня в 08:00.",
      ),
      toggle(
        memoryReportsEnabled(settings),
        T("Memory reports", "Отчёты памяти"),
        "rep",
        T(
          "turn the overnight reports on or off.",
          "включить или выключить отчёты.",
        ),
      ),
      toggle(
        digestEnabled(settings),
        T("Morning digest", "Утренний дайджест"),
        "dig",
        T(
          "turn the 08:00 digest on or off.",
          "включить или выключить дайджест.",
        ),
      ),
      toggle(
        parseProactive(settings, () => undefined).enabled,
        T("Writes on her own", "Сама пишет"),
        "pro",
        T(
          "Watch for missed items and the daily brief. Failures are always reported.",
          "Присмотр за пропущенным и обзор дня. О сбоях пишу всегда.",
        ),
      ),
      T(
        "Alerts — problems and updates — always arrive.",
        "Алерты — о проблемах и обновлениях — приходят всегда.",
      ),
      `${button(T("‹ Menu", "‹ Меню"), `iva_menu:${PARENT}:o`)} — ${T(
        "back to the settings.",
        "вернуться в настройки.",
      )}`,
    ];
    return { text: text.join("\n\n") };
  },
  async on(
    verb: string,
    args: string[],
    state: MenuState,
    ctx: MenuContext,
  ): Promise<void> {
    if (verb !== "set") return;
    const [target, value] = args;
    // Тап несёт и цель, и значение. Всё, что не из этого словаря, — протухшая или чужая
    // кнопка: настройки от неё не двигаются.
    if (typeof target !== "string" || !isToggle(target)) return;
    if (value !== "0" && value !== "1") return;
    const key = TOGGLES[target];
    const enabled = value === "1";
    // Вложенный объект патчится целиком под замком настроек — иначе соседние ключи
    // (расписание дайджеста, потолки Watch) были бы стёрты этим тапом.
    updateSettings((settings) => {
      const current = settings[key];
      const kept =
        typeof current === "object" &&
        current !== null &&
        !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      return { ...settings, [key]: { ...kept, enabled } };
    });
    await ctx.show(state, "ntc");
  },
};
