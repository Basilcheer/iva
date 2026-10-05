// Экран «🔔 Уведомления»: чем Iva имеет право прервать день. Тумблеры у Report'ов (ночные
// отчёты памяти), у «Сама пишет» и Insight (ADR-0022); алерты (проблемы и предложения
// обновиться) не выключаются, о чём экран говорит прямым текстом (ADR-0007).
//
// Тумблер пишется в data/settings.json, который и rollup, и тик Watch и Brief читают в
// момент запуска — переключение применяется без рестарта процессов. «Сама пишет» (Watch и
// Brief, ADR-0020) включён без ключа и выключает их, но не сообщения о сбоях. Insight
// выключен по умолчанию; кнопка ставит одно время из трёх, другое — `iva proactive set`.
// Состояние Insight (пауза, последний) экран читает из data/proactive.json; пишет его только
// тик.
//
// Правило репо: ни одной module-level const с переведённой строкой — подписи собираются в
// render() через ctx.tr, иначе язык замёрзнет до рестарта.
import { join } from "node:path";
import {
  parseProactive,
  withProactive,
  type ProactiveConfig,
} from "#lib/proactive-config.ts";
import { readSettings, updateSettings, type Settings } from "#lib/settings.ts";
import { resolveTimeZone } from "#lib/timezone.ts";
import { formatZoned } from "#lib/zoned-time.ts";
import {
  readProactiveState,
  type InsightState,
} from "../../proactive/state.ts";
import { memoryReportsEnabled } from "../notice-policy.ts";
import { button, buttonRow } from "./buttons.ts";

const PARENT = "r";

type MenuState = { page: number };
type Translate = (english: string, russian: string) => string;
type MenuContext = {
  deps: { dataDir: string };
  tr: Translate;
  show: (state: MenuState, screen: string) => Promise<void>;
};
type Write = (settings: Settings) => Settings;

// Целевой тумблер → ключ в settings.json. Аргумент callback_data — короткий ASCII-энум
// (грамматика в index.ts), а не имя ключа: мусорный аргумент просто не найдёт цели.
const TOGGLES = {
  rep: "memoryReports",
  pro: "proactive",
} as const;
type Toggle = keyof typeof TOGGLES;

function isToggle(value: string): value is Toggle {
  return Object.hasOwn(TOGGLES, value);
}

// Время Insight — аргумент кнопки без двоеточия: движок режет callback_data по «:».
const INSIGHT_SLOTS: Readonly<Record<string, readonly string[]>> = {
  "0": [],
  "0930": ["09:30"],
  "1130": ["11:30"],
  "1730": ["17:30"],
};
const INSIGHT_ROW = ["0930", "1130", "1730"] as const;

/** Тап по тумблеру: цель и значение из словаря, иначе null — протухшая или чужая кнопка. */
function toggleWrite(args: readonly string[]): Write | null {
  const [target, value] = args;
  if (typeof target !== "string" || !isToggle(target)) return null;
  if (value !== "0" && value !== "1") return null;
  const enabled = value === "1";
  if (target === "pro")
    return (settings) => withProactive(settings, "enabled", enabled);
  // Вложенный объект патчится целиком под замком настроек — иначе соседние ключи
  // (чат отчётов) были бы стёрты этим тапом.
  return (settings) => {
    const current = settings.memoryReports;
    const kept =
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};
    return { ...settings, memoryReports: { ...kept, enabled } };
  };
}

/** Тап по Insight: ровно один аргумент из словаря времён. */
function insightWrite(args: readonly string[]): Write | null {
  const [slot] = args;
  if (args.length !== 1 || !Object.hasOwn(INSIGHT_SLOTS, slot)) return null;
  const times = [...INSIGHT_SLOTS[slot]];
  return (settings) => withProactive(settings, "insightTimes", times);
}

type InsightView = {
  readonly times: readonly string[];
  readonly enabled: boolean;
  readonly unreadable: boolean;
  readonly paused: boolean;
  readonly insight?: InsightState;
};

/** Insight из data/proactive.json: нет файла — пусто; не читается — причина в журнал. */
function insightView(dataDir: string, config: ProactiveConfig): InsightView {
  const base = { times: config.insightTimes, enabled: config.enabled };
  try {
    const insight = readProactiveState(
      join(dataDir, "proactive.json"),
    )?.insight;
    const paused = (insight?.pausedUntilMs ?? 0) > Date.now();
    return { ...base, unreadable: false, paused, insight };
  } catch (error) {
    console.error("menu: proactive state unreadable:", error);
    return { ...base, unreadable: true, paused: false };
  }
}

// Строки статуса Insight по порядку проверок; выводятся все подходящие.
const INSIGHT_STATUS: ReadonlyArray<
  readonly [
    (view: InsightView) => boolean,
    (view: InsightView, T: Translate) => string,
  ]
> = [
  [
    (view) => view.unreadable,
    (_view, T) =>
      T(
        "⚠️ data/proactive.json is unreadable: no Watch, Brief or Insight until it is fixed.",
        "⚠️ data/proactive.json не читается: присмотра, обзора и инсайта не будет, пока файл не починят.",
      ),
  ],
  [
    (view) => view.times.length > 0 && !view.enabled,
    (_view, T) =>
      T(
        "Insight stays silent while «Writes on her own» is off.",
        "Инсайт не придёт, пока выключено «Сама пишет».",
      ),
  ],
  [
    (view) =>
      view.times.length > 0 && view.enabled && !view.paused && !view.unreadable,
    (view, T) =>
      T(
        `Insight: every day at ${view.times[0]}`,
        `Инсайт: каждый день в ${view.times[0]}`,
      ),
  ],
  [
    (view) => view.paused,
    (view, T) => {
      const until = formatZoned(
        view.insight?.pausedUntilMs ?? 0,
        resolveTimeZone(process.env.ASSISTANT_TIMEZONE),
      );
      return T(
        `Insight is paused until ${until}: two in a row were not installed.`,
        `Инсайт на паузе до ${until}: два подряд не поставлены.`,
      );
    },
  ],
  [
    ({ insight }) =>
      insight !== undefined && insight.draft !== "" && insight.day !== "",
    (view, T) =>
      T(
        `Last insight: ${view.insight?.day}.`,
        `Последний инсайт: ${view.insight?.day}.`,
      ),
  ],
];

function insightStatus(view: InsightView, T: Translate): string[] {
  return INSIGHT_STATUS.filter(([applies]) => applies(view)).map(([, text]) =>
    text(view, T),
  );
}

/** Ряд времён под включённым Insight; время не из ряда галочки не получает. */
function insightTimes(times: readonly string[], T: Translate): string[] {
  if (times.length === 0) return [];
  const slot = (arg: (typeof INSIGHT_ROW)[number]) => {
    const [time] = INSIGHT_SLOTS[arg];
    const label = time === times[0] ? `${time} ✓` : time;
    return button(label, `iva_menu:ntc:ins:${arg}`);
  };
  return [
    T("Insight time:", "Время инсайта:"),
    buttonRow(INSIGHT_ROW.map(slot)),
  ];
}

// Кнопка несёт значение, которое надо получить, а не «переключи»: повторный тап по
// протухшему меню приводит к тому же состоянию, а не мигает туда-обратно.
function switchLine(on: boolean, label: string, data: string, what: string) {
  return `${button(`${on ? "✓" : "○"} ${label}`, data)} — ${what}`;
}

/** Тумблер Insight: включает в 11:30 или выключает. */
function insightSwitch(times: readonly string[], T: Translate): string {
  const on = times.length > 0;
  return switchLine(
    on,
    T("Insight", "Инсайт"),
    `iva_menu:ntc:ins:${on ? "0" : "1130"}`,
    T(
      "once a day: a plugin draft for something you do by hand; installed only after your tap.",
      "раз в день: черновик плагина под то, что вы делаете руками; ставлю только после «Поставить».",
    ),
  );
}

/** «08:30 и 14:00» — времена Brief из настроек. */
function briefTimes(times: readonly string[], and: string): string {
  return times.length < 2
    ? times.join("")
    : `${times.slice(0, -1).join(", ")} ${and} ${times.at(-1)}`;
}

export default {
  parent: PARENT,
  render(_state: MenuState, ctx: MenuContext) {
    const settings = readSettings();
    const proactive = parseProactive(settings, () => undefined);
    const T = ctx.tr;
    const insight = insightView(ctx.deps.dataDir, proactive);
    const toggle = (on: boolean, label: string, target: Toggle, what: string) =>
      switchLine(
        on,
        label,
        `iva_menu:ntc:set:${target}:${on ? "0" : "1"}`,
        what,
      );
    const text = [
      `# ${T("🔔 Notices", "🔔 Уведомления")}`,
      [
        T(
          "Memory reports: what Iva filed overnight and over the week.",
          "Отчёты памяти: что Ива разложила за ночь и за неделю.",
        ),
        ...(proactive.briefTimes.length === 0
          ? []
          : [
              T(
                `Daily brief: ${briefTimes(proactive.briefTimes, "and")}`,
                `Обзор дня: ${briefTimes(proactive.briefTimes, "и")}`,
              ),
            ]),
        ...insightStatus(insight, T),
      ].join("\n"),
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
        proactive.enabled,
        T("Writes on her own", "Сама пишет"),
        "pro",
        T(
          "Watch for missed items, the daily brief and Insight. Failures are always reported.",
          "Присмотр за пропущенным, обзор дня и инсайт. О сбоях пишу всегда.",
        ),
      ),
      insightSwitch(proactive.insightTimes, T),
      ...insightTimes(proactive.insightTimes, T),
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
    // Тап несёт и цель, и значение. Всё, что не из словарей, — протухшая или чужая
    // кнопка: настройки от неё не двигаются и экран не перерисовывается.
    const write =
      verb === "ins"
        ? insightWrite(args)
        : verb === "set"
          ? toggleWrite(args)
          : null;
    if (write === null) return;
    updateSettings(write);
    await ctx.show(state, "ntc");
  },
};
