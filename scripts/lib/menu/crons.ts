// Экран кронов: read-only. systemctl --user list-timers (фильтр iva-* + xfeed-daily):
// «имя → следующий запуск», плюс счётчик задач из data/tasks.json, плюс блок расписаний
// внутри самой Ивы (agent/schedules/*.ts — Nitro scheduled tasks, не systemd) из
// data/rollup-status.json (scripts/lib/schedule-runner.ts). Пагинация systemd-списка по 8;
// блок расписаний Ивы всегда ровно 5 строк — не пагинируется.
//
// execFile ограничен таймаутом 1.5с и кэшируется на 60с — единственный getUpdates-цикл
// моста нельзя блокировать дольше (список таймеров редко висит, одной ограниченной пробы
// достаточно, async-перерисовка тут не нужна).
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readSettings } from "#lib/settings.mjs";

const PER_PAGE = 8;
const CACHE_TTL_MS = 60_000;
type Button = { text: string; callback_data: string };
type Timer = { unit: string; next: string };
type Translate = (english: string, russian: string) => string;
type RollupEntry = { lastSuccessAt?: unknown };
type MenuState = { page: number };
type MenuContext = {
  deps: { dataDir: string };
  tr: Translate;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
};
let cache: { at: number; timers: Timer[] | null } = { at: 0, timers: null };

// Cron strings mirrored by hand from agent/schedules/*.ts — same tradeoff as
// scripts/lib/schedule-migration.ts's PERIOD_SCHEDULE, there is no single shared source
// at the cron-string level. Status-file keys match the `name` each schedule passes to
// runScheduledJob (see scripts/lib/schedule-runner.ts), not the bare period.
const EVE_SCHEDULES = [
  { name: "memory-daily", cron: "0 4 * * *" },
  { name: "memory-weekly", cron: "15 4 * * 1" },
  { name: "memory-monthly", cron: "20 4 1 * *" },
  { name: "memory-yearly", cron: "25 4 1 1 *" },
  { name: "digest", cron: "0 8 * * *" },
];

function loadRollupStatus(dataDir: string): Record<string, RollupEntry> {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dataDir, "rollup-status.json"), "utf8"),
    );
    return typeof raw === "object" && raw !== null
      ? (raw as Record<string, RollupEntry>)
      : {};
  } catch {
    return {};
  }
}

function formatLastSuccess(entry: RollupEntry | undefined, T: Translate) {
  const at = entry?.lastSuccessAt;
  // typeof === "number" alone lets Infinity/-Infinity and other out-of-range values
  // through; new Date(at).toISOString() throws a RangeError on those and would take
  // the whole menu render down with it. Number.isFinite() plus a getTime() NaN check
  // (an out-of-range-but-finite value, e.g. beyond ±8.64e15) both fall back to "never".
  if (typeof at !== "number" || !Number.isFinite(at))
    return T("never", "никогда");
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return T("never", "никогда");
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
}

function digestEnabled() {
  // readSettings() resolves data/settings.json from ASSISTANT_DATA_DIR/cwd itself (see
  // agent/lib/settings.mjs) — same file agent/schedules/digest.ts reads at fire time,
  // so this always reflects the toggle digest.ts itself would see on its next tick.
  try {
    const settings = readSettings() as {
      digestSchedule?: { enabled?: boolean };
    };
    return settings.digestSchedule?.enabled === true;
  } catch {
    return false;
  }
}

function schedulesBlock(dataDir: string, T: Translate) {
  const status = loadRollupStatus(dataDir);
  const digestOn = digestEnabled();
  const lines = EVE_SCHEDULES.map((s) => {
    // digest fires off by default (agent/schedules/digest.ts) — "never" would be
    // indistinguishable from "enabled but hasn't run yet"; say so explicitly instead.
    if (s.name === "digest" && !digestOn) {
      return `• ${s.name} (${s.cron}) → ${T("disabled", "выключен")}`;
    }
    return `• ${s.name} (${s.cron}) → ${formatLastSuccess(status[s.name], T)}`;
  });
  return `${T("📅 Schedules (inside Iva)", "📅 Расписания (внутри Ивы)")}\n${lines.join("\n")}`;
}

function run(cmd: string, args: string[], timeout = 1500): Promise<string> {
  return new Promise((resolve: (stdout: string) => void) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout = "") =>
      resolve(String(stdout)),
    );
  });
}

// Толерантный парс: колонки list-timers переменной ширины (NEXT/LEFT содержат пробелы),
// поэтому берём только надёжное — имя таймера (*.timer) и ведущую абсолютную дату NEXT.
function parseTimers(stdout: string): Timer[] {
  const out: Timer[] = [];
  for (const line of stdout.split("\n")) {
    if (!/\.timer\b/.test(line)) continue; // пропускаем шапку/подвал/пустые
    const unit = (line.match(/(\S+\.timer)/) || [])[1];
    if (!unit) continue;
    if (!/^iva-/.test(unit) && !/^xfeed-daily/.test(unit)) continue;
    const dm = line.match(
      /^(\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: \S+)?)/,
    );
    out.push({ unit, next: dm ? dm[1] : "—" });
  }
  out.sort((a, b) => a.unit.localeCompare(b.unit));
  return out;
}

async function loadTimers() {
  if (cache.timers && Date.now() - cache.at < CACHE_TTL_MS) return cache.timers;
  const stdout = await run("systemctl", [
    "--user",
    "list-timers",
    "--all",
    "--no-pager",
  ]);
  const timers = parseTimers(stdout);
  cache = { at: Date.now(), timers };
  return timers;
}

export function openTaskCount(dataDir: string): number {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dataDir, "tasks.json"), "utf8"),
    );
    const wrapped =
      typeof raw === "object" && raw !== null
        ? (raw as { tasks?: unknown })
        : null;
    const arr = Array.isArray(raw)
      ? raw
      : Array.isArray(wrapped?.tasks)
        ? wrapped.tasks
        : [];
    return arr.filter(
      (task: unknown) =>
        !(task as { readonly done?: unknown } | null | undefined)?.done,
    ).length;
  } catch {
    return 0;
  }
}

export default {
  parent: "r",
  async render(st: MenuState, ctx: MenuContext) {
    const T = ctx.tr;
    const timers = await loadTimers();
    const taskCount = openTaskCount(ctx.deps.dataDir);
    const taskLine = T(
      `Tasks in queue: ${taskCount}`,
      `Задач в очереди: ${taskCount}`,
    );
    const head = T("⏰ Timers & tasks", "⏰ Кроны и задачи");
    const schedules = schedulesBlock(ctx.deps.dataDir, T);
    if (timers.length === 0) {
      return {
        text: `${head}\n\n${T("No Iva timers found.", "Таймеров Iva не найдено.")}\n${taskLine}\n\n${schedules}`,
        rows: [ctx.backRow("r")],
      };
    }
    const pages = Math.ceil(timers.length / PER_PAGE);
    const page = Math.min(Math.max(st.page || 0, 0), pages - 1);
    st.page = page;
    const body = timers
      .slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
      .map((t) => `• ${t.unit.replace(/\.timer$/, "")} → ${t.next}`)
      .join("\n");
    const rows = [];
    if (pages > 1) {
      rows.push([
        ctx.btn("‹", `iva_menu:cron:pg:${page > 0 ? page - 1 : 0}`),
        ctx.btn(`${page + 1}/${pages}`, `iva_menu:cron:pg:${page}`),
        ctx.btn(
          "›",
          `iva_menu:cron:pg:${page < pages - 1 ? page + 1 : pages - 1}`,
        ),
      ]);
    }
    rows.push(ctx.backRow("r"));
    return { text: `${head}\n\n${body}\n\n${taskLine}\n\n${schedules}`, rows };
  },
  on() {},
};
