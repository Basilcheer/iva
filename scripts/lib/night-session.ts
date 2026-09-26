// Сессия ночного хода: одна на ход. Её id лежит в data/rollup-session-<период>.json, пока
// ход может жить; уборка — отмена активного хода с задачами, ограниченный reset и удаление
// файла. Безопасность «второго писателя нет» держится на подтверждённом reset, а не на
// turn.cancelled: отмена гасит ход раньше, чем сервер стал бы ждать его на reset, и снимает
// задачи. Модель порядков — specs/NightSession.tla.
//
// Остатки (specs/README.md): окно create — abort или падение до ответа POST оставляет
// сессию без id в файле, её добивает sessionTimeoutMs eve (24 ч); задачи хода после reset
// родителя отдельно не подтверждаются.
import { readFileSync, rmSync } from "node:fs";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import {
  NIGHT_CANCEL_MS,
  NIGHT_RESET_MS,
  readNightTurn,
  turnMayBeLive,
  turnSummary,
  turnVerdict,
  type NightTurn,
  type TurnVerdict,
} from "./rollup-turn.ts";

/** То, что ночь зовёт у ClientSession eve. */
export interface NightSessionHandle {
  readonly state: { readonly sessionId: string };
  cancel(options: {
    readonly signal: AbortSignal;
    readonly tasks: true;
    readonly turnId?: string;
  }): Promise<{ readonly status: string }>;
  reset(options: {
    readonly reason: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** client.sessions eve: create шлёт первый ход, attach без I/O. */
interface NightSessions {
  create(input: {
    readonly message: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly session: NightSessionHandle;
    readonly response: AsyncIterable<unknown>;
  }>;
  attach(sessionId: string): NightSessionHandle;
}

export interface NightSessionContext {
  readonly sessions: NightSessions;
  /** data/rollup-session-<период>.json */
  readonly file: string;
  /** Срок или сигнал: новых сессий нет, текущая только снимается. */
  readonly stop: AbortSignal;
  readonly log: (line: string) => void;
  /** Журнал брошенных сессий (rollup-abandoned.jsonl); null — id неизвестен. */
  readonly abandoned: (sessionId: string | null, reason: string) => void;
}

/** Ход пишет id своей сессии в файл до чтения (rollup.ts отдаёт saveSession). */
export interface NightTurnContext extends NightSessionContext {
  readonly save: (sessionId: string) => void;
}

export interface NightTurnRun {
  readonly verdict: TurnVerdict;
  readonly turn: NightTurn | null;
  readonly sessionId: string | null;
  /** Сессия снята и файла нет: следующий create в этом запуске разрешён. */
  readonly retired: boolean;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface PersistedRollupSession {
  readonly sessionId: string;
  readonly createdAt: number;
}

const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim();

/** Ровно { sessionId, createdAt }: другой формат — не файл сессии. */
export function parsePersistedRollupSession(
  value: unknown,
): PersistedRollupSession | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== "createdAt,sessionId") return null;
  const { sessionId, createdAt } = record;
  return isSessionId(sessionId) &&
    typeof createdAt === "number" &&
    Number.isFinite(createdAt)
    ? { sessionId, createdAt }
    : null;
}

export function saveSession(file: string, sessionId: string): void {
  writeFileAtomicSync(
    file,
    JSON.stringify({ sessionId, createdAt: Date.now() }),
  );
}

/** Файла нет — null; нечитаем или не сессия — причина; иначе id. */
function readSavedSession(
  file: string,
): { readonly sessionId: string } | { readonly error: string } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    return { error: reasonOf(error) };
  }
  try {
    return (
      parsePersistedRollupSession(JSON.parse(text)) ?? {
        error: "not a {sessionId, createdAt} record",
      }
    );
  } catch (error) {
    return { error: reasonOf(error) };
  }
}

/** Отмена перед reset: id хода; null — активный ход, id не наблюдался; false — ход кончился сам. */
type CancelBefore = string | null | false;

/**
 * Уборка: отмена активного хода с задачами (сервер на reset ждал бы живой ход до 30 с),
 * затем ограниченный reset (клиент eve сам сверяет previousSessionId). reset или
 * no_active_session — писателя нет, файл снимается. Иначе файл остаётся, и следующий
 * старт повторит уборку.
 */
interface Retire {
  readonly reason: string;
  /** id сессии лежит в файле: неснятая остаётся там до следующего старта. */
  readonly saved: boolean;
  readonly cancel: CancelBefore;
}

async function retireSession(
  ctx: NightSessionContext,
  session: NightSessionHandle,
  { reason, saved, cancel }: Retire,
): Promise<boolean> {
  if (cancel !== false) await cancelOf(ctx, session, reason)(cancel);
  const id = session.state.sessionId;
  try {
    await session.reset({
      reason: `Rollup: ${reason}`,
      signal: AbortSignal.timeout(NIGHT_RESET_MS),
    });
  } catch (error) {
    ctx.abandoned(id, `${reason}-reset-failed`);
    ctx.log(
      saved
        ? `session ${id} was not reset (${reason}: ${reasonOf(error)}); ${ctx.file} keeps it for the next run, no new session in this one`
        : `session ${id} was not reset (${reason}: ${reasonOf(error)}) and is not in ${ctx.file}; eve ends it within 24 h`,
    );
    return false;
  }
  try {
    rmSync(ctx.file, { force: true });
  } catch (error) {
    ctx.log(
      `session ${id} is reset, but ${ctx.file} was not removed (${reasonOf(error)}); the next run resets it again`,
    );
    return false;
  }
  return true;
}

/**
 * Старт: сохранённая сессия — след упавшего процесса, её ход мог остаться на сервере.
 * Снимается до всего остального (отмена активного хода без id, затем reset); false — выход
 * с кодом 1 без create.
 */
export async function resetSavedSession(
  ctx: NightSessionContext,
): Promise<boolean> {
  const saved = readSavedSession(ctx.file);
  if (saved === null) return true;
  if ("error" in saved) {
    ctx.log(
      `${ctx.file} is unreadable or not a session file (${saved.error}); if it names a session, reset it by hand (POST /eve/v1/session/<id>/reset), then delete the file`,
    );
    return false;
  }
  ctx.abandoned(saved.sessionId, "crash");
  return await retireSession(ctx, ctx.sessions.attach(saved.sessionId), {
    reason: "crash",
    saved: true,
    cancel: null,
  });
}

/** Отмена с задачами, ограниченная сроком; не бросает, отдаёт статус для журнала. */
function cancelOf(
  ctx: NightSessionContext,
  session: NightSessionHandle,
  label: string,
) {
  return (turnId: string | null): Promise<string> =>
    session
      .cancel({
        ...(turnId === null ? {} : { turnId }),
        tasks: true,
        signal: AbortSignal.timeout(NIGHT_CANCEL_MS),
      })
      .then(
        ({ status }) => status,
        (error: unknown) => `failed (${reasonOf(error)})`,
      )
      .then((status) => {
        ctx.log(`${label}: cancel of turn ${turnId ?? "(active)"}: ${status}`);
        return status;
      });
}

type OpenedTurn = {
  readonly session: NightSessionHandle;
  readonly response: AsyncIterable<unknown>;
};

/**
 * create → файл. Ответа нет — id неизвестен; ответ при остановке — только уборка; файл не
 * записался — уборка и конец запуска. Иначе сессия названа в файле и её ход можно читать.
 */
async function openTurn(
  ctx: NightTurnContext,
  prompt: string,
  label: string,
): Promise<OpenedTurn | NightTurnRun> {
  let created: OpenedTurn;
  try {
    created = await ctx.sessions.create({ message: prompt, signal: ctx.stop });
  } catch (error) {
    // Ответа POST нет: сервер мог принять ход, но id клиенту не достался (окно create).
    ctx.abandoned(null, `${label}-create-failed`);
    ctx.log(
      `${label}: create failed (${reasonOf(error)}); session id unknown — if the server started it, eve ends it within 24 h`,
    );
    return { verdict: "broken", turn: null, sessionId: null, retired: false };
  }
  const { session } = created;
  const stopped = {
    verdict: "broken" as const,
    turn: null,
    sessionId: session.state.sessionId,
  };
  // Ответ пришёл, когда запуск уже останавливается: сессию не храним и не читаем; её ход
  // уже идёт на сервере, отмена без id.
  if (ctx.stop.aborted)
    return {
      ...stopped,
      retired: await retireSession(ctx, session, {
        reason: `${label}-stopped`,
        saved: false,
        cancel: null,
      }),
    };
  try {
    ctx.save(session.state.sessionId);
  } catch (error) {
    ctx.log(`${label}: ${ctx.file} was not written (${reasonOf(error)})`);
    await retireSession(ctx, session, {
      reason: `${label}-unsaved`,
      saved: false,
      cancel: null,
    });
    return { ...stopped, retired: false };
  }
  return created;
}

/**
 * Что отменять перед reset: обрез уже отменён; failed (turn.failed, чужая отмена) — задачи
 * хода могли остаться, отмена с задачами; broken без границы — ход мог остаться живым;
 * completed и session.failed — только reset.
 */
function cancelBefore(
  turn: NightTurn | null,
  verdict: TurnVerdict,
): CancelBefore {
  if (turn === null) return null;
  if (turn.cutRequested) return false;
  if (verdict === "failed" || (verdict === "broken" && turnMayBeLive(turn)))
    return turn.turnId;
  return false;
}

/**
 * Один ход в своей сессии: create → файл → чтение одним владельцем → уборка (отмена, если
 * ход мог остаться живым или его задачи — затем reset). Ошибка клиента в чтении или сводке
 * не обходит уборку.
 */
export async function runNightTurn(
  ctx: NightTurnContext,
  prompt: string,
  label: string,
): Promise<NightTurnRun> {
  const opened = await openTurn(ctx, prompt, label);
  if ("verdict" in opened) return opened;
  const { session, response } = opened;
  const cancel = cancelOf(ctx, session, label);
  let turn: NightTurn | null = null;
  let verdict: TurnVerdict = "broken";
  let retired: boolean;
  try {
    const read = await readNightTurn(response, cancel, (line) =>
      ctx.log(`${label}: ${line}`),
    );
    turn = read.turn;
    verdict = turnVerdict(turn, read.error);
    if (read.error !== undefined)
      ctx.log(`${label}: the turn stream broke (${reasonOf(read.error)})`);
    ctx.log(`${label}: ${turnSummary(turn, verdict)}`);
  } finally {
    // (a) отмена, если ход или его задачи могли остаться, и отмена по пределу не уходила;
    // (b) всегда reset и удаление файла.
    retired = await retireSession(ctx, session, {
      reason: `${label}-${verdict}`,
      saved: true,
      cancel: cancelBefore(turn, verdict),
    });
  }
  return { verdict, turn, sessionId: session.state.sessionId, retired };
}
