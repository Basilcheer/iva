// Notice — всё, что Iva говорит сама, без хода пользователя (CONTEXT.md). Видов ровно два,
// и у каждого своё правило (ADR-0007):
//   • Report — плановая сводка (отчёты памяти, утренний дайджест). По умолчанию выключен,
//     включается тумблером в /menu → 🔔 Уведомления.
//   • Alert — проблема, с которой владельцу надо что-то сделать (brain, оффер обновления).
//     Не выключается — и потому обязан говорить, что делать, и не повторяться чаще раза
//     в неделю на одну и ту же проблему.
//
// Здесь только политика: кому и когда можно говорить. Транспорт приносит вызывающий
// (у моста, ночного brain и апдейтера он разный), поэтому каждая отправка — колбэк.
//
// Модуль обязан грузиться на установке без authored tree (scripts/authored-tree-guard.test.ts):
// ночной brain и проверка обновлений — юниты, которые должны работать на половине установки.
// Поэтому `agent/` достаётся динамическим импортом внутри вызова и всегда fail-open.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type Translate = (english: string, russian: string) => string;
type Language = "en" | "ru";
type Env = Record<string, string | undefined>;

// Один и тот же вопрос «на каком языке говорить» решает резолвер из authored tree
// (settings.language → AGENT_LANGUAGE → ru). Без дерева остаётся его же последний шаг —
// env: молчать или гадать хуже, чем сказать по-русски на русской установке.
type LangResolver = { getLang: () => Language };

export async function noticeLang(
  env: Env = process.env,
  load: () => Promise<LangResolver> = () => import("#lib/i18n.ts"),
): Promise<Language> {
  try {
    return (await load()).getLang();
  } catch (error) {
    console.error("[notices] language resolver unavailable:", error);
    return env.AGENT_LANGUAGE === "en" ? "en" : "ru";
  }
}

/** Пара литералов на месте вызова — идиома репо (agent/lib/i18n.ts), без словарей. */
export async function noticeTranslator(
  env: Env = process.env,
  load?: () => Promise<LangResolver>,
): Promise<Translate> {
  const lang = await noticeLang(env, load);
  return (english, russian) => (lang === "ru" ? russian : english);
}

// ── Report: отчёты памяти ────────────────────────────────────────────────────────────────
// Ключ settings — по образцу digestSchedule: объект, а не голый флаг, чтобы соседние
// настройки отчётов не пришлось заводить новым ключом верхнего уровня.
export function memoryReportsEnabled(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const reports = (settings as { memoryReports?: unknown }).memoryReports;
  if (typeof reports !== "object" || reports === null) return false;
  return (reports as { enabled?: unknown }).enabled === true;
}

/**
 * Хвост ночного промпта — та его часть, что описывает ДОСТАВКУ отчёта: язык, форму и
 * запрет доставить себя самому. Язык называется явно: без этого модель пишет отчёт на
 * языке инструкции, и пользователь получает половину сообщения по-английски.
 */
export function memoryReportTail(tr: Translate): string {
  return (
    `At the end, return a SHORT report, written in ${tr("English", "Russian")}. ` +
    `Plain text, no markdown tables. Write it in the first person, the way a person tells ` +
    `what they remembered in this pass: 3-5 short lines. ` +
    `Use everyday words only: no card operations (ADD/UPDATE/SUPERSEDE/NOOP), no field ` +
    `names, no file paths, no internal terms. ` +
    `Return the report as the final text of this turn. Do not send it anywhere yourself: ` +
    `no rich messages, no digest chat, no Telegram tools. ` +
    `Only the finished report, with no preamble or reasoning.`
  );
}

/** Одноразовый Notice после апдейта: утро замолчало не потому, что что-то сломалось. */
export function memoryReportsOffNotice(tr: Translate): string {
  return tr(
    "Morning memory reports are now off by default. Turn them on: /menu → 🔔 Notices.",
    "Утренние отчёты памяти теперь выключены. Включить: /menu → 🔔 Уведомления.",
  );
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;
}

/**
 * Notice, который говорится ровно один раз за всю жизнь установки. Заявка на право
 * сказать — атомарный O_EXCL: две ночные свёртки (daily и weekly) стартуют одну за
 * другой, и проигравшая обязана молчать, а не повторять. Заявка возвращается, если
 * отправка не состоялась: несказанный Notice хуже сказанного дважды.
 */
export async function noticeOnce(
  dataDir: string,
  name: string,
  send: () => Promise<boolean>,
): Promise<"sent" | "already" | "failed"> {
  const path = join(dataDir, `notice-${name}.json`);
  try {
    mkdirSync(dataDir, { recursive: true });
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(
        fd,
        `${JSON.stringify({ notifiedAt: new Date().toISOString() })}\n`,
      );
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (errorCode(error) === "EEXIST") return "already";
    console.error(`[notices] could not claim the "${name}" notice:`, error);
    return "failed";
  }
  if (await send()) return "sent";
  try {
    rmSync(path, { force: true });
  } catch {
    /* заявка останется — тогда Notice не повторится; молчать безопаснее, чем спамить */
  }
  return "failed";
}

// ── Alert: тревога, которую нельзя выключить ─────────────────────────────────────────────
export const ALERT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

type AlertRecord = { essence: string; lastSentAt: number };
type AlertState = Record<string, AlertRecord>;

function alertStatePath(dataDir: string): string {
  return join(dataDir, "alert-state.json");
}

// Битый, недописанный или чужой формат состояния значит «слать»: fail-open. Замолчавшая
// тревога стоит дороже, чем увиденная дважды, поэтому непонятная запись просто теряется.
function readAlertState(dataDir: string): AlertState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(alertStatePath(dataDir), "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {};
  const state: AlertState = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) continue;
    const { essence, lastSentAt } = value as {
      essence?: unknown;
      lastSentAt?: unknown;
    };
    if (
      typeof essence === "string" &&
      typeof lastSentAt === "number" &&
      Number.isFinite(lastSentAt)
    )
      state[key] = { essence, lastSentAt };
  }
  return state;
}

async function writeAlertState(
  dataDir: string,
  state: AlertState,
): Promise<void> {
  try {
    // Атомарная запись — из authored tree, поэтому динамически: brain обязан работать и
    // без него. Не записалось — тревога повторится завтра, а это безопасная сторона.
    const { writeFileAtomicSync } = await import("#lib/fs-atomic.ts");
    writeFileAtomicSync(alertStatePath(dataDir), `${JSON.stringify(state)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    console.error("[notices] could not record the alert state:", error);
  }
}

/**
 * Пора ли говорить: записи нет, существо проблемы сменилось, прошла неделя — или часы
 * ушли назад (запись из будущего иначе заглушила бы тревогу навсегда).
 */
export function alertDue(
  dataDir: string,
  key: string,
  essence: string,
  now: number = Date.now(),
): boolean {
  const record = readAlertState(dataDir)[key];
  if (!record) return true;
  if (record.essence !== essence) return true;
  const elapsed = now - record.lastSentAt;
  return elapsed >= ALERT_REPEAT_MS || elapsed < 0;
}

/**
 * Тревога с дросселем. Состояние обновляется только после состоявшейся отправки:
 * неотправленная тревога не имеет права заглушить следующую.
 */
export async function alertOnce(
  dataDir: string,
  key: string,
  essence: string,
  send: () => Promise<boolean>,
): Promise<"sent" | "throttled" | "failed"> {
  if (!alertDue(dataDir, key, essence)) return "throttled";
  if (!(await send())) return "failed";
  const state = readAlertState(dataDir);
  state[key] = { essence, lastSentAt: Date.now() };
  await writeAlertState(dataDir, state);
  return "sent";
}

/** Проблема ушла: забыть её, чтобы завтрашний рецидив заговорил сразу, а не через неделю. */
export async function alertResolved(
  dataDir: string,
  key: string,
): Promise<void> {
  const state = readAlertState(dataDir);
  if (!(key in state)) return; // нечего забывать — и незачем трогать файл
  delete state[key];
  await writeAlertState(dataDir, state);
}
