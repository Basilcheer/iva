// Rollup: one parameterized script for all periods (daily → weekly → monthly → yearly).
// Run by the in-process eve schedules in agent/schedules/memory-*.ts, drives Iva
// via eve/client (like scripts/daily-digest.ts), and posts a report to Telegram for daily/weekly.
//
//   node --env-file=.env scripts/memory/rollup.ts <daily [YYYY-MM-DD]|weekly|monthly|yearly>
//
// daily без даты разбирает пропущенные дни окна (rollup-days.ts), с датой — ровно этот день.
// Requires: a running agent (eve start) and a vault to write into. The processing rules
// (scripts/memory/instructions/) ship with the repo and go into the prompt as text.
// Date is in ASSISTANT_TIMEZONE.
//
// Порядок запуска: аргументы → .memory.lock → сохранённая сессия упавшего процесса снимается
// → только потом инструкции, vault, timezone, CORE и дни (их отказ завершает запуск, и живой
// сессии за ним уже нет). Каждый ход — своя сессия eve (scripts/lib/night-session.ts),
// предел хода считает ночной клиент (scripts/lib/rollup-turn.ts).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "eve/client";
import { CORE_CAP } from "#lib/core-cap.ts";
import { coreDamage, setLastDayPointer } from "#lib/core-clamp.ts";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import {
  commitVaultWrite,
  vaultHead,
  vaultShow,
  type VaultCommit,
} from "#lib/vault-commit.ts";
import { tr } from "#lib/i18n.ts";
import { readSettings } from "#lib/settings.ts";
import { JOB_STOP_AT_ENV } from "#lib/schedule-runner.ts";
import { memoryLockPath } from "#lib/schedule-paths.ts";
import {
  alertOnce,
  alertResolved,
  coreDamageAlert,
  CORE_DAMAGE_ALERT_KEY,
  deliverMemoryReport,
  memoryReportTail,
  memoryReportsEnabled,
  rollupRanBefore,
} from "../lib/notice-policy.ts";
import { resolveDataDir } from "../lib/data-dir.ts";
import { childLinkRule } from "../lib/rollup-children.ts";
import { resolveTimeZone } from "../lib/timezone.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { readCore } from "./read-core.ts";
import { underMemoryLock } from "../lib/memory-lock.ts";
import { NIGHT_MIN_TURN_MS, resolveStopAt } from "../lib/rollup-turn.ts";
import {
  resetSavedSession,
  runNightTurn,
  saveSession,
  type NightSessionContext,
  type NightTurnContext,
  type NightTurnRun,
} from "../lib/night-session.ts";
import {
  addAttempt,
  clearDay,
  DAY_PAUSED_ALERT_KEY,
  dayPausedAlert,
  isExhausted,
  readAttempts,
  type AttemptReason,
} from "../lib/rollup-attempts.ts";
import {
  dayProgress,
  droppedDay,
  isDayDone,
  LOOKBACK_DAYS,
  pausedDays,
  pendingDays,
  shiftDate,
  type DayState,
} from "../lib/rollup-days.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";
import { vaultDirOrExit } from "../lib/vault-boundary.ts";
import {
  nightInstructionSection,
  nightInstructionsOrExit,
  type NightPeriod,
} from "../lib/night-instructions.ts";

type Period = NightPeriod;

const PERIODS: readonly Period[] = ["daily", "weekly", "monthly", "yearly"];
// process.argv: [node, script, <period>] — the period is the first CLI argument.
const period = process.argv[2] as Period | undefined;
// Необязательная дата дня для daily: ручной догон конкретного пропущенного дня.
const dateArg = process.argv[3];

if (
  !period ||
  !PERIODS.includes(period) ||
  (dateArg !== undefined &&
    (period !== "daily" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(dateArg) ||
      shiftDate(dateArg, 0) !== dateArg))
) {
  console.error(`Usage: rollup.ts <daily [YYYY-MM-DD]|weekly|monthly|yearly>`);
  process.exit(1);
}

// Один писатель ночной памяти: раннер держит .memory.lock сам и говорит об этом окружением,
// прямой запуск перезапускает себя под тем же flock (scripts/lib/memory-lock.ts).
const locked = underMemoryLock(memoryLockPath(process.cwd()));
if (locked !== null) process.exit(locked);

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BEARER = process.env.ASSISTANT_BEARER; // needed if the prod eve channel requires auth
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = notificationChat();
// Absolute: the prompt hands these paths to the model as
// read_file/write_file targets, and read_file resolves a RELATIVE path against the vault
// root — a "vault/daily/…" string would come back as vault/vault/daily/… and ENOENT.
let vaultCache: string | null = null;
// Лениво: неверная настройка вольта всплывает на первом использовании, где её ловит
// граница процесса — одна строка причины и код 1, а не стек на импорте модуля.
const VAULT = (): string => (vaultCache ??= vaultDirOrExit());

// daily/weekly may carry a Report to Telegram; monthly/yearly are silent by design (vault
// only). Whether the Report actually goes out is the owner's switch, read at the end of the
// run — a toggle flipped tonight applies tonight, with no restart (ADR-0007).

const REPORTS_TO_TELEGRAM: Record<Period, boolean> = {
  daily: true,
  weekly: true,
  monthly: false,
  yearly: false,
};

// Current date in the user's timezone (iva.service sets TZ from .env, but we hedge anyway).
function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// We take the target period as COMPLETED: schedules fire at the start of a new period
// (daily ≈04:00, weekly on Mon, monthly on the 1st, yearly on Jan 1), so we process
// the PREVIOUS period, not the empty current one (now is the current local date).
// Задание ночи для daily: разбор сырого дня в карточки, сводка дня, CORE и уроки.
// Отметку части читает код: «докуда дошли» детерминированно, модель продолжает с неё.
function dailyTask(day: string): string {
  const raw = readDay(day).raw;
  const resumeAfter = raw === null ? null : dayProgress(raw).through;
  return (
    `Process the raw transcript of the completed day (${VAULT()}/daily/${day}.md): ` +
    `extract entities and create/update autograph cards. ` +
    `Work through the day in parts and mark each finished part in the transcript with a part marker, per the ` +
    `memory-processor skill (section memory-processor above): a cut run resumes from that marker. ` +
    (resumeAfter === null
      ? ""
      : `Entries up to and including ${resumeAfter} are already processed (the last processed-through ` +
        `marker): start with the first entry after ${resumeAfter}, and extend the day's existing summary. `) +
    `Prefer the write_card tool over write_file ` +
    `for cards — it enforces the schema. For each fact choose one operation: ADD (new), ` +
    `UPDATE (existing subject, compatible new fact), SUPERSEDE (contradicts the Compiled Truth), ` +
    `or NOOP (already known). Pass history_entry only for SUPERSEDE, never for ADD, UPDATE, or NOOP. ` +
    `On SUPERSEDE: REWRITE the card's Compiled Truth (frontmatter + top description) to the new fact ` +
    `and pass the OLD value through history_entry as a single dated line 'YYYY-MM-DD: fact' — ` +
    `the fact the card holds now, matched against the card's body ('Owner: Alice.' becomes ` +
    `'2026-07-31: Owner: Alice'; a summary is refused) — the fact's own date, not today's; ` +
    `write_card owns the '## History' section. ` +
    `A card 'body' is facts only, with no H1/H2 headings: write_card builds the card ` +
    `structure itself (the title, '## Log', '## Related', '## History') and refuses a body ` +
    `that carries a heading of its own. ` +
    `Never leave two contradictory Compiled Truths; History is append-only, never edited. ` +
    `Tag each fact's certainty with 'confidence:' — EXTRACTED (user stated it directly) or ` +
    `INFERRED (you deduced it). ` +
    `Emotional venting and momentary states ("I'm useless", "wasted the whole day", tiredness, ` +
    `frustration) are NEVER identity-level facts: never put them into CORE or entity cards. ` +
    `At most mention them as a dated mood line in the daily-summary, or — only if clearly worth ` +
    `keeping — a note card with status: archived. ` +
    `First read ${VAULT()}/.graph/supersede-candidates.json (the deterministic conflict scan) and ` +
    `resolve every listed same-entity conflict by superseding the stale card. ` +
    `Then assemble a daily-summary for ${day} with the day's topics and MOC links down to the cards ` +
    `and to the raw transcript daily/${day}.md. ` +
    `Link a card only by the 'file' path write_card returned in this turn, or by a path memory_search ` +
    `or read_file showed you; never derive a path from a title — a slug is lowercased, its punctuation ` +
    `becomes '-', and it is cut at 60 characters, so a derived path points at no file. ` +
    `Then ${VAULT()}/CORE.md, per the core-format section above. If the day produced ` +
    `no new durable fact, preference, goal or behavioral lesson, do not open or write CORE.md. ` +
    `Otherwise edit only the affected lines; never rewrite the file; keep every existing section, ` +
    `including ones not in the template. The pointer to the last day is set by code — leave it alone. ` +
    `Keep the file ≤~${CORE_CAP} characters — compress on overflow, don't bloat. ` +
    `Separately, reflect on the day's interactions: for each notable exchange judge the outcome — ` +
    `useful, dead_end, or corrected (user corrected you, asked again, or was dissatisfied). ` +
    `When a corrected/dead_end outcome reveals a REPEATABLE behavioral lesson (not a one-off fix), ` +
    `add/refine ONE dated line in the CORE Preferences section (e.g. '- 2026-07: отвечать короче, ` +
    `без преамбул') so you don't repeat it. Keep lessons recency-ordered, drop the stalest when the ` +
    `section grows; a lesson consistently honored for weeks can be dropped. Skip this whole step if ` +
    `the day held no corrections (no-op — don't invent lessons). `
  );
}

// day — разбираемый день daily; прочие периоды считают от вчера сами.
function buildPrompt(
  p: Period,
  now: string,
  day: string,
  rules: string,
): string {
  const [y, m] = now.split("-").map(Number);
  const yesterday = shiftDate(now, -1);
  const prevMonth =
    m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const prevYear = String(y - 1);

  const intro =
    `You are processing long-term memory (vault: ${VAULT()}). It is now ${now} (${TZ}). ` +
    (p === "daily"
      ? `Work strictly by the memory-processor skill and the format rules under "Night instructions" below. `
      : `Work strictly by the period's rule below, under "Night instructions". `) +
    `Each "### Rules: <name>" section is one rule, and "section <name>" in the texts means it; ` +
    `they are complete here, do not look for them on disk. ` +
    `Do not invent facts — take them from the source files.` +
    // Правила ночи текстом (scripts/lib/night-instructions.ts): путь к ним модель не прочтёт.
    `\n\n## Night instructions\n\n${rules}\n\n## Tonight's task\n\n`;

  // Delivery half of the prompt: language, human wording, no self-delivery. Built per call,
  // so a language switched in /menu applies to the next night without a restart.
  const tail = memoryReportTail(tr);

  switch (p) {
    case "daily":
      return intro + dailyTask(day) + tail;
    case "weekly":
      return (
        intro +
        `Assemble a weekly-summary for the completed week (7 days ending ${yesterday}): ` +
        `read the daily-summaries of those 7 days, pull out cross-cutting topics and the week's takeaways, ` +
        `create a weekly-summary with MOC links down to those daily-summaries. ` +
        childLinkRule("weekly", yesterday, VAULT()) +
        tail
      );
    case "monthly":
      return (
        intro +
        `Assemble a monthly-summary for the completed month ${prevMonth}: ` +
        `read the weekly-summaries of month ${prevMonth}, pull out the main topics and the month's takeaways, ` +
        `create a monthly-summary with MOC links down to the weekly summaries. ` +
        childLinkRule("monthly", prevMonth, VAULT()) +
        tail
      );
    case "yearly":
      return (
        intro +
        `Assemble a yearly-summary for the completed year ${prevYear}: ` +
        `read the monthly-summaries of year ${prevYear}, pull out the main topics and the year's takeaways, ` +
        `create a yearly-summary with MOC links down to the monthly summaries. ` +
        childLinkRule("yearly", prevYear, VAULT()) +
        tail
      );
  }
}

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: () => Promise.resolve(BEARER) } } : {}),
});

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Брошенные сессии (упавший процесс, неснятая сессия, create без ответа) — в журнал: по нему
// видно, чьи сессии могли остаться на сервере. Диагностика: на ветвление не влияет, отказ
// записи ночь не роняет. null — id неизвестен (ответа create не было).
function logAbandoned(sessionId: string | null, reason: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(
      join(DATA_DIR, "rollup-abandoned.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        period,
        reason,
        sessionId,
      }) + "\n",
      "utf8",
    );
  } catch {
    /* журнал не должен ронять ночь */
  }
}

// Остановка — срок или сигнал: новых сессий нет, идущий ход снимается уборкой. Обработчики
// постоянные: повторный сигнал ничего не делает и не отдаёт процесс стандартному завершению
// посреди уборки. Сигнал до установки обработчика, OOM и kill -9 оставляют файл сессии —
// его снимет следующий старт.
const stop = new AbortController();
function requestStop(why: string): void {
  if (stop.signal.aborted) return;
  console.error(
    `rollup ${period}: ${why} — stopping: no new session, the current one is cleaned up`,
  );
  stop.abort(new Error(`rollup stopped: ${why}`));
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => requestStop(signal));

// Каждый ход ночи — своя сессия eve, снятая сразу после хода: блок правил и прошлые дни не
// копятся в контексте следующего дня и следующей ночи. Файл сессии хранит её id, пока ход
// может жить; найденный при старте файл остался от упавшего процесса — ту сессию снимаем
// первой, до всего, что способно завершить запуск.
const DATA_DIR = resolveDataDir(process.cwd());
const SESSION_FILE = join(DATA_DIR, `rollup-session-${period}.json`);
const night: NightSessionContext = {
  sessions: client.sessions,
  file: SESSION_FILE,
  stop: stop.signal,
  log: (line) => console.error(`rollup ${period}: ${line}`),
  abandoned: logAbandoned,
};
if (!(await resetSavedSession(night))) process.exit(1);

// Правила ночи читаются один раз; отказ — одна строка и код 1.
const NIGHT_RULES = nightInstructionsOrExit(period);
// Ход коррекции CORE идёт в своей сессии: правило формата ему нужно текстом.
const CORE_FORMAT_RULE =
  period === "daily"
    ? nightInstructionsOrExit(period, () =>
        nightInstructionSection("rules/core-format.md"),
      )
    : "";
const TZ = resolveTimeZone(process.env.ASSISTANT_TIMEZONE);
// Did a rollup ever run on this installation? Read here, before this run leaves traces of
// its own, and read from every trace at once (session files of all four periods, the schedule
// status file, daily summaries in the vault) — one session file is not enough: it lives only
// while a turn runs (a crashed run's file is already reset above). It separates an
// installation that used to get the morning report from a fresh one, which has nothing to miss
// and must hear nothing. Best-effort by design: ADR-0007.
const RAN_BEFORE = rollupRanBefore(DATA_DIR, VAULT());
// Свой след прогон оставляет только ходами: id сессии ложится в файл после ответа create.
const turns: NightTurnContext = {
  ...night,
  save: (sessionId) => saveSession(SESSION_FILE, sessionId),
};

// Срок один — срок запуска у раннера (agent/lib/schedule-runner.ts): после него остаётся срок
// остановки до SIGTERM. Срок останавливает запуск так же, как сигнал.
const STOP_AT = resolveStopAt(process.env[JOB_STOP_AT_ENV], Date.now());
const remainingMs = (): number => STOP_AT - Date.now();
setTimeout(() => requestStop("stop time"), remainingMs()).unref();

// Сырой день и его сводка — вход детерминированной половины (rollup-days.ts).
function readDay(date: string): DayState {
  let raw: string | null;
  try {
    raw = readFileSync(join(VAULT(), "daily", `${date}.md`), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    raw = null;
  }
  return {
    raw,
    summaryExists: existsSync(
      join(VAULT(), "summaries", "daily", `${date}.md`),
    ),
  };
}

// Новейший сделанный день окна. Указатель CORE не уходит назад, когда догон
// разбирает день старше уже сделанного.
function latestDoneDay(): string | null {
  for (let back = 0; back < LOOKBACK_DAYS; back++) {
    const date = shiftDate(yesterday, -back);
    if (isDayDone(readDay(date))) return date;
  }
  return null;
}

const CORE_PATH = join(VAULT(), "CORE.md");

// CORE как есть. Отсутствующий файл — пустое состояние первой ночи (ровно то, что видит
// динамическая инструкция CORE); любой другой отказ чтения остаётся громким.
function readCoreText(path: string): string {
  const read = readCore(path);
  if (read.state === "unreadable") throw read.error;
  return read.state === "valid" ? read.text : "";
}

// Сессия последнего хода — ключ журнала для алертов и отчёта этого запуска.
let nightSession = "";

const today = localDate();
const yesterday = shiftDate(today, -1);
// Отметку конца скилл ставит только законченному дню: сегодня и будущее — не день сводки.
if (dateArg !== undefined && dateArg >= today) {
  console.error(
    `rollup daily: ${dateArg} is not a finished day in ${TZ} (today is ${today})`,
  );
  process.exit(1);
}
// Попытки дня (scripts/lib/rollup-attempts.ts): день с тремя наблюдёнными отказами догон не
// берёт, владелец слышит об этом. Ручной запуск с датой — решение владельца: предел его не
// держит, и оповещение он не трогает.
const ATTEMPTS_FILE = join(DATA_DIR, "rollup-attempts.json");
const attempts = (() => {
  if (period !== "daily") return {};
  try {
    return readAttempts(ATTEMPTS_FILE);
  } catch (error) {
    console.error(`rollup daily: ${reasonOf(error)}`);
    process.exit(1);
  }
})();
const exhausted = (date: string): boolean => isExhausted(attempts[date]);
const catchUp = period === "daily" && dateArg === undefined;
// Дни этого запуска: для daily — дата из аргумента или пропущенные дни окна, старые
// первыми; прочие периоды считают свой период от вчера.
const days =
  period !== "daily"
    ? [yesterday]
    : dateArg !== undefined
      ? [dateArg]
      : pendingDays(yesterday, readDay, exhausted);
const paused = catchUp ? pausedDays(yesterday, readDay, exhausted) : [];
if (paused.length > 0)
  await alertOwner(
    DAY_PAUSED_ALERT_KEY,
    paused.join(","),
    dayPausedAlert(tr, paused, attempts),
  );
else if (catchUp) alertResolved(DATA_DIR, DAY_PAUSED_ALERT_KEY);
const dropped = catchUp ? droppedDay(yesterday, readDay) : null;
if (dropped !== null)
  console.error(
    `rollup daily: ${dropped} is not processed and left the catch-up window — run rollup.ts daily ${dropped} to process it`,
  );
if (days.length === 0) {
  console.log(
    paused.length > 0
      ? `rollup daily (${today}): ${paused.join(", ")} wait for the owner after repeated failures`
      : `rollup daily (${today}): every day of the window is processed`,
  );
  process.exit(0);
}
// Отказ самого дня (обрез, ход без отчёта, незакрытый день) — попытка дня.
function markAttempt(day: string, reason: AttemptReason): void {
  if (period === "daily")
    addAttempt(ATTEMPTS_FILE, day, reason, new Date().toISOString());
}

type DayEnd = "done" | "cut" | "stop";

// Итог дня по исходу его хода. Обрез подтверждён — попытка дня, снята сессия или нет:
// подтверждение уборки решает только, идёт ли догон дальше (цикл ниже).
function dayEnd(day: string, run: NightTurnRun): DayEnd {
  if (run.verdict === "cut") {
    markAttempt(day, "cut");
    console.error(
      `rollup ${period}: ${day} was cut by the turn ceiling — partial progress, the next run resumes it from its part marker`,
    );
    return "cut";
  }
  if (run.verdict !== "completed") {
    console.error(
      `rollup ${period}: ${day}: the turn ended ${run.verdict} — no attempt is counted, the next run takes the day again`,
    );
    return "stop";
  }
  const message = run.turn?.message ?? "";
  if (!message) {
    markAttempt(day, "no-report");
    console.error(`rollup ${period}: agent returned no report for ${day}`);
    return "stop";
  }
  // Отчёт без отметки конца дня — незаконченный день, а не сделанный: следующий запуск
  // продолжит его с последней отметки части.
  const state = readDay(day);
  if (period === "daily" && state.raw !== null && !isDayDone(state)) {
    markAttempt(day, "day-unfinished");
    console.error(
      `rollup daily: ${day} is not marked done after the turn — the next run resumes it`,
    );
    return "stop";
  }
  if (period === "daily") clearDay(ATTEMPTS_FILE, day);
  reports.push(message);
  return "done";
}

// Один день — один ход в своей сессии. Обрез пределом — частичный прогресс: попытка дня,
// догон идёт дальше, запуск кончается кодом 1. Прочие отказы и неснятая сессия
// останавливают догон: провал не двигает «последний успех», и догон продолжит день с его
// отметки.
const reports: string[] = [];
// Запуск кончится кодом 1.
let failed = false;
// Каждый ход дошёл до исхода (успех или обрез) и его сессия снята: CORE доводится как
// после успеха.
let settled = true;
let turnsRan = false;
for (const day of days) {
  if (stop.signal.aborted || remainingMs() < NIGHT_MIN_TURN_MS) {
    console.error(
      `rollup ${period}: ${day} is not started — ${stop.signal.aborted ? "the run is stopping" : `${Math.round(remainingMs() / 1000)} s left before the stop time`}; the next run takes it`,
    );
    failed = true;
    break;
  }
  turnsRan = true;
  let end: DayEnd;
  try {
    // Снимок CORE ДО каждого хода — коммит в истории vault (coreSnapshot): что с правкой хода
    // делать, решает его исход (settleCore), откат — из этого коммита.
    const coreBeforeTurn = period === "daily" ? await coreSnapshot() : "";
    const run = await runNightTurn(
      turns,
      buildPrompt(period, today, day, NIGHT_RULES),
      day,
    );
    if (run.sessionId !== null) nightSession = run.sessionId;
    // Неснятая сессия: ход может быть жив, vault не трогаем — ни CORE, ни коммита; история
    // на месте, восстановить можно позже.
    if (run.retired) await settleCore(day, run, coreBeforeTurn);
    // dayEnd идёт и при неснятой сессии: пишет только data/rollup-attempts.json, vault читает.
    const dayResult = dayEnd(day, run);
    end = run.retired ? dayResult : "stop";
  } catch (error) {
    // Ошибка клиента (снимок CORE, сводка, чтение дня, запись попытки): уборка хода уже
    // прошла или ход не начинался, попытка не ставится.
    console.error(`rollup ${period}: ${day}: ${reasonOf(error)}`);
    end = "stop";
  }
  if (end === "done") continue;
  failed = true;
  if (end === "cut") continue;
  settled = false;
  break;
}
const report = reports.join("\n\n");

// Алерт владельцу тем же путём, что у brain: один дроссель на всю установку (ADR-0007),
// доставка — через шов наружу, который несёт и outbound-гейт.
async function alertOwner(
  key: string,
  essence: string,
  message: string,
): Promise<void> {
  const outcome = await alertOnce(DATA_DIR, key, essence, async () => {
    if (!BOT || !CHAT) {
      console.error(
        `rollup ${period}: no TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — alert not sent: ${message}`,
      );
      return false;
    }
    const sent = await sendTelegramHtml(BOT, CHAT, message, {
      trace: { session: nightSession, source: "rollup" },
    });
    if (!sent.ok)
      console.error(`rollup ${period}: alert send failed: ${sent.error}`);
    return sent.ok;
  });
  if (outcome === "throttled")
    console.log(
      `rollup ${period}: ${key} is unchanged since the last alert — not repeated`,
    );
}

// Снимок CORE — история vault, не память процесса: грязный CORE коммитится (файла нет —
// коммитить нечего), sha HEAD — снимок, и он сверяется с файлом: коммит не состоялся (vault
// внутри чужого репозитория, занятый индекс, чужой коммит между) — ход не начинается.
async function coreSnapshot(): Promise<string> {
  if (existsSync(CORE_PATH))
    await commitVaultWrite("file CORE.md: before turn", [CORE_PATH], VAULT());
  const sha = await vaultHead(VAULT());
  if ((await coreAt(sha)) !== readCoreText(CORE_PATH))
    throw new Error(
      `CORE.md on disk does not match its snapshot commit ${sha} in ${VAULT()} — the turn is not started`,
    );
  return sha;
}

// Отказ коммита памяти: явный, или «не коммитили» с причиной (vault внутри чужого
// репозитория). «Нечего коммитить» причины не несёт и отказом не является.
function commitFailed(commit: VaultCommit): string | null {
  return !commit.ok || (!commit.committed && commit.reason !== undefined)
    ? (commit.reason ?? "unknown")
    : null;
}

// Текст CORE в снимке; файла в коммите не было — пустой текст той же проверке. Иной отказ
// git (vaultShow) — исключение: откатывать в пустоту нельзя.
async function coreAt(sha: string): Promise<string> {
  return (await vaultShow(VAULT(), sha, "CORE.md")) ?? "";
}

// CORE как в снимке: частичную правку оборванного хода не оставляем. Откат — тоже правка
// памяти: коммит обязателен (порча без коммита даёт «нечего коммитить», это не отказ); отказ
// коммита возвращается с причиной — файл на диске уже возвращён, вызывающий сначала говорит
// это владельцу, отказ коммита называет последней строкой и выходит кодом 1.
type Restore = "restored" | "unchanged" | { readonly commitFailed: string };
async function restoreCore(snapshot: string, why: string): Promise<Restore> {
  if (readCoreText(CORE_PATH) === snapshot) return "unchanged";
  writeFileAtomicSync(CORE_PATH, snapshot);
  const failed = commitFailed(
    await commitVaultWrite(
      `file CORE.md: restore (${why})`,
      [CORE_PATH],
      VAULT(),
    ),
  );
  return failed === null ? "restored" : { commitFailed: failed };
}

// Последняя строка перед выходом: откат уже на диске и уже назван, владелец уже услышал.
function exitOnCommitFailure(restore: Restore): void {
  if (typeof restore !== "object") return;
  console.error(
    `rollup daily: CORE.md restored on disk, commit failed: ${restore.commitFailed}`,
  );
  process.exit(1);
}

// CORE после хода, сессия которого снята. Ход дошёл до исхода или обрезан: его правка
// законна, но он мог снести секцию целиком — в том числе пользовательскую, которой нет в
// шаблоне. Это потеря данных, поэтому файл возвращается как был, и владелец слышит об этом:
// молчаливый откат читался бы как «ночь ничего не записала» (ADR-0002, ADR-0007). Любой
// другой исход — ход не завершён, его правка CORE — полуправка: файл байт в байт как до хода.
async function settleCore(
  day: string,
  run: NightTurnRun,
  snapshot: string,
): Promise<void> {
  if (period !== "daily") return;
  const before = await coreAt(snapshot);
  if (run.verdict !== "completed" && run.verdict !== "cut") {
    const restore = await restoreCore(before, `${day} ${run.verdict}`);
    // Файл возвращён и при отказе коммита: строка верна в обоих случаях.
    if (restore !== "unchanged")
      console.error(
        `rollup daily: ${day}: the turn ended ${run.verdict} — CORE.md is back to its pre-turn text`,
      );
    exitOnCommitFailure(restore);
    return;
  }
  exitOnCommitFailure(
    (await coreDamaged(before, readCoreText(CORE_PATH), day)).restore,
  );
}

// Одна проверка повреждения для дневного хода и коррекции: раздел пропал или опустел —
// откатить к снимку, потом сказать и оповестить владельца (алерт «вернула файл» не обгоняет
// сам возврат: между ними могут быть ENOSPC или kill). Выход — у вызывающего, по `restore`.
async function coreDamaged(
  before: string,
  after: string,
  why: string,
): Promise<{ readonly damaged: boolean; readonly restore: Restore }> {
  const damage = coreDamage(before, after);
  if (!damage.damaged) {
    alertResolved(DATA_DIR, CORE_DAMAGE_ALERT_KEY);
    return { damaged: false, restore: "unchanged" };
  }
  const restore = await restoreCore(before, why);
  const damagedHeadings = [
    // Оба вида потери: пропавшие и выхолощенные разделы.
    ...damage.lostHeadings,
    ...damage.hollowedHeadings,
  ];
  const lost = damagedHeadings.map((h) => `## ${h}`).join(", ");
  console.error(
    `rollup daily: CORE.md lost ${lost || "all of its content"} during the turn — restored the pre-turn file`,
  );
  await alertOwner(
    CORE_DAMAGE_ALERT_KEY,
    damagedHeadings.join(",") || "emptied",
    coreDamageAlert(tr, damagedHeadings),
  );
  return { damaged: true, restore };
}

// Daily is the only rollup that touches CORE. Each turn settled its own CORE above; the
// last-day pointer is written and one correction of the cap is allowed only when every turn
// reached its outcome and its session is retired — then fail loudly and leave brain as the
// deterministic 05:00 backstop.
if (period === "daily" && turnsRan) {
  // Ход не дошёл до исхода или сессия не снята: vault дальше не трогаем.
  if (!settled) process.exit(1);
  // A non-empty pre-existing vault may legitimately have no CORE. The turn starts from
  // the same empty state that the dynamic CORE instruction already documents and uses.
  let core = readCoreText(CORE_PATH);

  // Указатель на последний день ведёт код: дата известна точно, а модели тут нечего
  // решать — за неё она платила бы полным перезаписыванием файла. Пишем только если
  // строка реально изменилась, иначе день без новых фактов трогал бы vault впустую.
  const lastDay = latestDoneDay();
  const pointed = lastDay === null ? core : setLastDayPointer(core, lastDay);
  if (pointed !== core) {
    writeFileAtomicSync(CORE_PATH, pointed);
    const failed = commitFailed(
      await commitVaultWrite("file CORE.md: pointer", [CORE_PATH], VAULT()),
    );
    if (failed !== null) {
      console.error(
        `rollup daily: CORE.md pointer written on disk, commit failed: ${failed}`,
      );
      process.exit(1);
    }
    core = pointed;
  }

  if (core.length > CORE_CAP) {
    const oldLength = core.length;
    console.error(
      `rollup daily: CORE.md still exceeds the cap (${oldLength}/${CORE_CAP}); requesting one correction`,
    );
    // Своя сессия и правило формата текстом: сессии дней уже сняты. Коррекция не дошла до
    // исхода (обрез, сбой, остановка) — CORE как до неё, и дальше срабатывает проверка капа.
    // Остановились — vault не трогаем: снимок только перед стартующим ходом.
    const starting = !stop.signal.aborted && remainingMs() >= NIGHT_MIN_TURN_MS;
    const snapshot = starting ? await coreSnapshot() : null;
    const before = snapshot === null ? null : await coreAt(snapshot);
    const fixed =
      snapshot === null
        ? null
        : await runNightTurn(
            turns,
            `${CORE_FORMAT_RULE}\n\nRe-open ${CORE_PATH}: it is ${oldLength} characters, above the hard ${CORE_CAP}-character cap. ` +
              "Compress it now per the core-format section above. Preserve every heading and the Pointers/Указатели " +
              "section; remove stale Preferences/Предпочтения first. Do not return until the file itself is within the cap.",
            "core-correction",
          );
    // Сессия коррекции не снята: ход может быть жив, CORE не трогаем (остаток).
    if (fixed !== null && !fixed.retired) {
      console.error(
        `rollup daily: CORE.md correction ${fixed.verdict}, its session is not retired — CORE.md is left as the turn left it (${oldLength}/${CORE_CAP}); brain will clamp it at 05:00`,
      );
      process.exit(1);
    }
    if (fixed?.verdict !== "completed" || before === null) {
      const restore =
        before === null ? "unchanged" : await restoreCore(before, "correction");
      console.error(
        `rollup daily: CORE.md correction ${fixed?.verdict ?? "not started"} — CORE.md is back to its pre-correction text (${oldLength}/${CORE_CAP}); brain will clamp it at 05:00`,
      );
      exitOnCommitFailure(restore);
      process.exit(1);
    }
    const correctedCore = readCore(CORE_PATH);
    if (correctedCore.state === "unreadable") throw correctedCore.error;
    // Коррекция проходит ту же проверку повреждения, что дневной ход: «# CORE» — не сжатие,
    // удалённый файл — пустой текст той же проверки.
    const corrected = correctedCore.state === "valid" ? correctedCore.text : "";
    // Повреждение коррекцией — всегда код 1 (откат состоялся или нет: сказано в stderr).
    const { damaged, restore } = await coreDamaged(
      before,
      corrected,
      "correction",
    );
    exitOnCommitFailure(restore);
    if (damaged) process.exit(1);
    core = corrected;
    if (core.length > CORE_CAP) {
      console.error(
        `rollup daily: CORE.md remains over cap after one correction (${core.length}/${CORE_CAP}); ` +
          "brain will clamp it at 05:00",
      );
      process.exit(1);
    }
    console.log(
      `rollup daily: CORE.md compressed ${oldLength} → ${core.length} chars`,
    );
  }
}

console.log(`rollup ${period} (${today}):\n${report}`);
// Отказ дня (обрез, провал, неснятая сессия, остановка): отчёт остаётся в журнале.
if (failed) process.exit(1);

// Telegram report only for daily/weekly, and only when the owner turned Reports on. What
// leaves the chat is one decision, taken in the policy module and proven there by test:
// the report, or — once in the life of an installation that used to get it — the notice
// that reports are now off. Never both, never twice.
if (REPORTS_TO_TELEGRAM[period]) {
  const settings = readSettings();
  // markdown → Telegram-HTML conversion, chunking, the outbound Gate and the self-heal all
  // live in the shared seam. No token or chat means no seam — and the policy still decides
  // the one-time notice, so a chat configured later cannot revive a question already closed.
  const send =
    BOT && CHAT
      ? {
          // Ночной ход зовётся своим именем в журнале хода (ADR-0010): без источника
          // вьюер прочитал бы rollup как разговор в Telegram. Сессия — сквозная,
          // по ней читатель сшивает весь ночной ход.
          report: (text: string) =>
            sendTelegramHtml(BOT, CHAT, text, {
              trace: {
                session: nightSession,
                source: "rollup",
              },
            }),
          notice: (text: string) =>
            sendTelegramHtml(BOT, CHAT, text, {
              trace: {
                session: nightSession,
                source: "rollup",
              },
            }),
        }
      : null;
  if (!send && memoryReportsEnabled(settings)) {
    console.error(
      `rollup ${period}: no TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — report not sent`,
    );
    process.exit(1);
  }
  const delivery = await deliverMemoryReport({
    dataDir: DATA_DIR,
    settings,
    ranBefore: RAN_BEFORE,
    report,
    tr,
    send,
  });
  if (delivery.status === "off") {
    if (delivery.notice === "sent")
      console.log(`rollup ${period}: told the chat that reports are now off`);
    if (delivery.notice === "failed")
      console.error(
        `rollup ${period}: could not deliver the reports-off notice`,
      );
    console.log(
      `rollup ${period}: memory reports are off — the report stays in the log`,
    );
    process.exit(0);
  }
  const r = delivery;
  // Сессия отчёта уже снята, учить форматированию некого: только след в журнале.
  if (r.fellBack)
    console.error(
      `rollup ${period}: the report failed parse_mode=HTML (${r.error}) and went out as flat text`,
    );
  if (r.status === "failed") {
    console.error(`rollup ${period}: Telegram send failed:`, r.error);
    process.exit(1);
  }
  console.log(`rollup ${period}: report sent to Telegram.`);
}

process.exit(0);
