/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// Сессия ночного хода (scripts/lib/night-session.ts): снятие сохранённой сессии при старте,
// create → файл → чтение → уборка (отмена, затем reset), остановка на каждом шаге. Двойник
// client.sessions eve помнит вызовы по порядку; поток хода — async-итератор, который, как у
// eve (open-stream.js), тихо кончается по abort своего сигнала.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import type { NightTurnContext, NightSessionHandle } from "./night-session.ts";

// Сроки уборки для этого файла короткие (шов rollup-turn.ts): тест зависшего cancel/reset
// не ждёт боевые 20 и 40 с. Модули читают окружение при загрузке, поэтому импорт ниже.
process.env.IVA_NIGHT_CANCEL_MS = "60";
process.env.IVA_NIGHT_RESET_MS = "90";
const {
  parsePersistedRollupSession,
  resetSavedSession,
  runNightTurn,
  saveSession,
} = await import("./night-session.ts");
const { NIGHT_CANCEL_MS, NIGHT_MAX_STEPS, NIGHT_RESET_MS } =
  await import("./rollup-turn.ts");

const TURN = "turn_day";
const SEED = 20260926;
let nextId = 0;
const ev = (type: string, data: Record<string, unknown> = {}) => ({
  type,
  data: { turnId: TURN, sequence: 0, ...data },
  meta: { at: "2026-09-26T04:00:00.000Z", id: `evt_${++nextId}` },
});
const done = (message = "отчёт") => [
  ev("turn.started"),
  ev("step.started", { stepIndex: 0 }),
  ev("step.completed", { stepIndex: 0, usage: { inputTokens: 10 } }),
  ev("message.completed", { finishReason: "stop", message, stepIndex: 0 }),
  ev("turn.completed"),
  ev("session.waiting", { wait: "next-user-message" }),
];

interface FakeOptions {
  /** События хода; функция — чтобы видеть сигнал и файл в момент чтения. */
  readonly events?: (signal: AbortSignal) => AsyncIterable<unknown>;
  /** create до ответа: бросить (abort) или вызвать что-то в этот момент. */
  readonly onCreate?: (signal: AbortSignal) => void;
  readonly createFails?: boolean;
  /** Ответ create дошёл, хотя сигнал поднят во время POST. */
  readonly lateResponse?: boolean;
  readonly reset?: (id: string, signal: AbortSignal) => Promise<unknown>;
  readonly cancel?: (signal: AbortSignal) => Promise<{ status: string }>;
}

/** Вызов без ответа, как fetch к зависшему серверу: кончается только по своему сигналу. */
const hung = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    // Причина сигнала у AbortSignal.timeout — DOMException TimeoutError, как у fetch.
    const fail = () => reject(new Error(String(signal.reason)));
    if (signal.aborted) fail();
    signal.addEventListener("abort", fail, { once: true });
  });

function world(
  t: { after: (fn: () => void) => void },
  options: FakeOptions = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "iva-night-session-"));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { force: true, recursive: true });
  });
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const log: string[] = [];
  const abandoned: string[] = [];
  const handle = (id: string): NightSessionHandle => ({
    state: { sessionId: id },
    cancel: (o) => {
      calls.push(
        `cancel ${id} ${o.turnId ?? "(active)"}${o.tasks ? " +tasks" : ""}`,
      );
      signals.push(o.signal);
      return (
        options.cancel?.(o.signal) ?? Promise.resolve({ status: "accepted" })
      );
    },
    reset: (o) => {
      calls.push(`reset ${id} ${o.reason}`);
      signals.push(o.signal);
      return (
        options.reset?.(id, o.signal) ??
        Promise.resolve({ status: "reset", previousSessionId: id })
      );
    },
  });
  const stop = new AbortController();
  const file = join(dir, "rollup-session-daily.json");
  const ctx: NightTurnContext = {
    file,
    save: (sessionId) => saveSession(file, sessionId),
    stop: stop.signal,
    log: (line) => log.push(line),
    abandoned: (id, reason) => abandoned.push(`${id} ${reason}`),
    sessions: {
      create: ({ signal }) => {
        calls.push("create");
        options.onCreate?.(signal);
        if (options.createFails || (signal.aborted && !options.lateResponse))
          return Promise.reject(new DOMException("aborted", "AbortError"));
        const events = options.events?.(signal) ?? iterate(done());
        return Promise.resolve({ session: handle("s1"), response: events });
      },
      attach: (id) => handle(id),
    },
  };
  return { ctx, calls, signals, log, abandoned, stop, file, dir };
}

async function* iterate(events: readonly unknown[]) {
  for (const event of events) yield await Promise.resolve(event);
}

/** Поток, который после events ждёт; abort сигнала кончает его без границы, как у eve. */
async function* hangAfter(events: readonly unknown[], signal: AbortSignal) {
  yield* iterate(events);
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

test("the persisted Rollup session is exactly sessionId plus createdAt", () => {
  assert.deepEqual(
    parsePersistedRollupSession({
      sessionId: "wrun_01M1BRB1YVQXJEQR806RPZYTC4",
      createdAt: 1_788_100_000_000,
    }),
    {
      sessionId: "wrun_01M1BRB1YVQXJEQR806RPZYTC4",
      createdAt: 1_788_100_000_000,
    },
  );
  for (const value of [
    {
      state: {
        ["continuationToken"]: "legacy",
        sessionId: "wrun_legacy",
        streamIndex: 27,
      },
      createdAt: 1_788_100_000_000,
    },
    { sessionId: "", createdAt: 1 },
    { sessionId: " wrun_space ", createdAt: 1 },
    { sessionId: "wrun_bad_time", createdAt: "now" },
    { sessionId: "wrun_extra", createdAt: 1, streamIndex: 2 },
  ]) {
    assert.equal(parsePersistedRollupSession(value), null);
  }
});

test("property: persisted Rollup session parsing never crashes on junk", () => {
  fc.assert(
    fc.property(fc.anything(), (value) => {
      const parsed = parsePersistedRollupSession(value);
      assert.ok(parsed === null || Object.keys(parsed).length === 2);
    }),
    { seed: 24_611, numRuns: 200 },
  );
});

test("a create rejected before a response from the server leaves no result: the session id is unknown, nothing is reset", async (t) => {
  const { ctx, calls, abandoned, log, file } = world(t, { createFails: true });
  const run = await runNightTurn(ctx, "day", "2026-09-25");
  assert.deepEqual(run, {
    verdict: "broken",
    turn: null,
    sessionId: null,
    retired: false,
  });
  assert.deepEqual(calls, ["create"]);
  assert.deepEqual(abandoned, ["null 2026-09-25-create-failed"]);
  assert.match(log.join("\n"), /session id unknown/u);
  assert.equal(existsSync(file), false);
});

test("the file names the session while its turn is read, and is gone after the reset with the result", async (t) => {
  const seen: string[] = [];
  const w = world(t, {
    events: () =>
      (async function* () {
        seen.push(readFileSync(w.file, "utf8"));
        yield* iterate(done("отчёт дня"));
      })(),
  });
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  assert.equal(run.verdict, "completed");
  assert.equal(run.turn?.message, "отчёт дня");
  assert.equal(run.retired, true);
  assert.deepEqual(Object.keys(JSON.parse(seen[0] ?? "{}") as object).sort(), [
    "createdAt",
    "sessionId",
  ]);
  assert.equal(
    parsePersistedRollupSession(JSON.parse(seen[0] ?? "{}"))?.sessionId,
    "s1",
  );
  assert.deepEqual(w.calls, [
    "create",
    "reset s1 Rollup: 2026-09-25-completed",
  ]);
  assert.equal(existsSync(w.file), false);
});

test("no_active_session at start is a confirmed reset, not an error: the file is removed", async (t) => {
  const { ctx, file } = world(t, {
    reset: () => Promise.resolve({ status: "no_active_session" }),
  });
  writeFileSync(file, JSON.stringify({ sessionId: "wrun_gone", createdAt: 1 }));
  assert.equal(await resetSavedSession(ctx), true);
  assert.equal(existsSync(file), false);
});

test("an unreadable or foreign-format session file fails closed: the start stops without a reset", async (t) => {
  for (const junk of [
    "{not json",
    JSON.stringify({ state: { sessionId: "wrun_legacy", streamIndex: 3 } }),
    JSON.stringify({ sessionId: "", createdAt: 1 }),
  ]) {
    const { ctx, calls, log, file } = world(t);
    writeFileSync(file, junk);
    assert.equal(await resetSavedSession(ctx), false, junk);
    assert.deepEqual(calls, [], "nothing to address: fail closed");
    assert.equal(
      readFileSync(file, "utf8"),
      junk,
      "the file stays for the owner",
    );
    assert.match(
      log.join("\n"),
      /rollup-session-daily\.json is unreadable or not a session file/u,
    );
  }
});

test("a reset the client refuses (a foreign previousSessionId) keeps the file and refuses the start", async (t) => {
  const { ctx, file, log } = world(t, {
    // Так клиент eve бросает на чужой previousSessionId (session-controls.js).
    reset: () =>
      Promise.reject(new Error("Reset route returned an invalid response.")),
  });
  writeFileSync(
    file,
    JSON.stringify({ sessionId: "wrun_saved", createdAt: 1 }),
  );
  assert.equal(await resetSavedSession(ctx), false);
  assert.match(readFileSync(file, "utf8"), /wrun_saved/u);
  assert.match(
    log.join("\n"),
    /session wrun_saved was not reset .*keeps it for the next run/u,
  );
});

test("session.failed is reset only: the cancel of the turn is never called", async (t) => {
  const w = world(t, {
    events: () =>
      iterate([
        ev("turn.started"),
        ev("session.failed", {
          code: "Error",
          message: "hook threw",
          sessionId: "s1",
        }),
      ]),
  });
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  assert.equal(run.verdict, "session-failed");
  assert.deepEqual(w.calls, [
    "create",
    "reset s1 Rollup: 2026-09-25-session-failed",
  ]);
});

test("a stop while the ceiling cancel is pending leaves one cancel and a reset", async (t) => {
  const steps = Array.from({ length: NIGHT_MAX_STEPS + 1 }, (_, i) =>
    ev("step.started", { stepIndex: i }),
  );
  const w = world(t, {
    events: (signal) => hangAfter([ev("turn.started"), ...steps], signal),
    // Отмена по пределу висит, пока срок не поднял остановку.
    cancel: () => {
      w.stop.abort();
      return new Promise((resolve) =>
        setTimeout(() => resolve({ status: "accepted" }), 20),
      );
    },
  });
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  assert.equal(run.verdict, "broken");
  assert.equal(run.turn?.cutRequested, true);
  assert.deepEqual(w.calls, [
    "create",
    `cancel s1 ${TURN} +tasks`,
    "reset s1 Rollup: 2026-09-25-broken",
  ]);
});

test(`property: the start never crashes on junk session files and resets only a valid one (seed ${SEED})`, async (t) => {
  const junk = fc.oneof(
    fc.string(),
    fc.jsonValue().map((value) => JSON.stringify(value)),
    fc
      .record({ sessionId: fc.string(), createdAt: fc.double() })
      .map((value) => JSON.stringify(value)),
  );
  await fc.assert(
    fc.asyncProperty(junk, async (text) => {
      const { ctx, calls, file } = world(t);
      writeFileSync(file, text);
      let valid: string | null;
      try {
        valid =
          parsePersistedRollupSession(JSON.parse(text))?.sessionId ?? null;
      } catch {
        valid = null;
      }
      const started = await resetSavedSession(ctx);
      assert.equal(started, valid !== null);
      assert.deepEqual(
        calls,
        valid === null
          ? []
          : [`cancel ${valid} (active) +tasks`, `reset ${valid} Rollup: crash`],
      );
      assert.equal(
        existsSync(file),
        valid === null,
        "junk stays for the owner, a reset session goes",
      );
    }),
    { seed: SEED, numRuns: 60 },
  );
});

test("a file that cannot be removed after the reset fails the start, and the next run resets it again", async (t) => {
  const { ctx, file, dir, calls } = world(t);
  writeFileSync(
    file,
    JSON.stringify({ sessionId: "wrun_stuck", createdAt: 1 }),
  );
  chmodSync(dir, 0o555);
  assert.equal(await resetSavedSession(ctx), false);
  chmodSync(dir, 0o755);
  assert.equal(existsSync(file), true);
  assert.equal(
    await resetSavedSession(ctx),
    true,
    "the next start finishes it",
  );
  assert.deepEqual(calls, [
    "cancel wrun_stuck (active) +tasks",
    "reset wrun_stuck Rollup: crash",
    "cancel wrun_stuck (active) +tasks",
    "reset wrun_stuck Rollup: crash",
  ]);
});

test("a stream that ends without a boundary cancels the turn with its tasks, then resets", async (t) => {
  const w = world(t, {
    events: () =>
      iterate([ev("turn.started"), ev("step.started", { stepIndex: 0 })]),
  });
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  assert.equal(run.verdict, "broken");
  assert.deepEqual(w.calls, [
    "create",
    `cancel s1 ${TURN} +tasks`,
    "reset s1 Rollup: 2026-09-25-broken",
  ]);
  // Ход, чей turnId не пришёл, гасится как активный ход своей сессии.
  const quiet = world(t, { events: () => iterate([]) });
  await runNightTurn(quiet.ctx, "day", "2026-09-25");
  assert.deepEqual(quiet.calls.slice(1, 2), ["cancel s1 (active) +tasks"]);
});

test("a failed session file write resets the fresh session and never reads the turn", async (t) => {
  let pulled = 0;
  const w = world(t, {
    events: () =>
      (async function* () {
        pulled += 1;
        yield* iterate(done());
      })(),
  });
  // Каталог данных без права записи: ENOSPC/EACCES на атомарной записи файла сессии.
  chmodSync(w.dir, 0o555);
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  chmodSync(w.dir, 0o755);
  assert.equal(run.retired, false, "the run must stop");
  assert.equal(pulled, 0);
  // Ход уже идёт на сервере, его id не читался: отмена активного хода, затем reset.
  assert.deepEqual(w.calls, [
    "create",
    "cancel s1 (active) +tasks",
    "reset s1 Rollup: 2026-09-25-unsaved",
  ]);
});

test("a reset that fails after the turn keeps the session file, and no new session is allowed", async (t) => {
  const w = world(t, {
    reset: () => Promise.reject(new Error("503 Service Unavailable")),
  });
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  assert.equal(run.verdict, "completed");
  assert.equal(run.retired, false);
  assert.match(readFileSync(w.file, "utf8"), /"sessionId":"s1"/u);
  assert.deepEqual(w.abandoned, ["s1 2026-09-25-completed-reset-failed"]);
});

test("a saved session of a previous run is reset before the turn, then its file is removed and the crash is journaled", async (t) => {
  const { ctx, calls, file, abandoned, signals } = world(t);
  writeFileSync(
    file,
    JSON.stringify({ sessionId: "wrun_crashed", createdAt: 1 }),
  );
  assert.equal(await resetSavedSession(ctx), true);
  // Ход упавшего процесса мог остаться живым, его id неизвестен: отмена активного хода с
  // задачами, затем reset — сервер на reset живой ход не ждёт.
  assert.deepEqual(calls, [
    "cancel wrun_crashed (active) +tasks",
    "reset wrun_crashed Rollup: crash",
  ]);
  assert.equal(existsSync(file), false);
  assert.deepEqual(abandoned, ["wrun_crashed crash"]);
  assert.ok(signals[0] instanceof AbortSignal, "the cancel is bounded");
  assert.ok(signals[1] instanceof AbortSignal, "the reset is bounded");
});

test("a missing session file at start is nothing to reset: not an error, the turn goes on", async (t) => {
  const { ctx, calls } = world(t);
  assert.equal(await resetSavedSession(ctx), true);
  assert.deepEqual(calls, []);
});

test("a late create response after the stop is only reset: never saved, not read", async (t) => {
  let read = false;
  const w = world(t, {
    // Ответ POST уже в пути, когда сигнал поднимает остановку: create отдаёт сессию.
    lateResponse: true,
    onCreate: () => w.stop.abort(),
    events: () =>
      (async function* () {
        read = true;
        yield* iterate(done());
      })(),
  });
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  assert.equal(run.retired, true);
  assert.deepEqual(w.calls, [
    "create",
    "cancel s1 (active) +tasks",
    "reset s1 Rollup: 2026-09-25-stopped",
  ]);
  assert.equal(read, false, "the stream of a stopped run is not read");
  assert.equal(existsSync(w.file), false, "and its id is never saved");
});

test("a pause (session.waiting without an outcome) until the stop is cancelled and reset like a broken turn", async (t) => {
  const w = world(t, {
    events: (signal) =>
      hangAfter(
        [
          ev("turn.started"),
          ev("authorization.required", {
            name: "gws",
            description: "d",
            stepIndex: 0,
            webhookUrl: "https://x",
          }),
          ev("session.waiting", { wait: "next-user-message" }),
        ],
        signal,
      ),
  });
  setTimeout(() => w.stop.abort(), 30);
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  assert.equal(run.verdict, "broken");
  assert.deepEqual(w.calls.slice(1), [
    `cancel s1 ${TURN} +tasks`,
    "reset s1 Rollup: 2026-09-25-broken",
  ]);
});

test("the session file record refuses a foreign shape: exact keys, a trimmed id, a finite time", () => {
  const parse = parsePersistedRollupSession;
  const valid = parse({ sessionId: "wrun_a", createdAt: 1 });
  assert.equal(valid?.sessionId, "wrun_a");
  assert.equal(parse({ sessionId: "wrun_a", createdAt: 0 })?.createdAt, 0);
  assert.equal(parse(null), null);
  assert.equal(parse("wrun_a"), null);
  assert.equal(parse([]), null);
  assert.equal(parse({}), null);
  assert.equal(parse({ sessionId: "wrun_a" }), null);
  assert.equal(parse({ createdAt: 1 }), null);
  assert.equal(parse({ sessionId: 7, createdAt: 1 }), null);
  assert.equal(parse({ sessionId: "", createdAt: 1 }), null);
  assert.equal(parse({ sessionId: "wrun_a ", createdAt: 1 }), null);
  assert.equal(parse({ sessionId: "wrun_a", createdAt: "1" }), null);
  assert.equal(parse({ sessionId: "wrun_a", createdAt: NaN }), null);
  assert.equal(parse({ sessionId: "wrun_a", createdAt: Infinity }), null);
  assert.equal(parse({ sessionId: "wrun_a", createdAt: 1, extra: 1 }), null);
  assert.equal(parse({ sessionId: "wrun_a", createdAt: 1, state: {} }), null);
});

test("the night stop during reading aborts the stream from the client without an error: one cancel, then a reset, and the file is gone", async (t) => {
  const w = world(t, {
    events: (signal) =>
      hangAfter(
        [ev("turn.started"), ev("step.started", { stepIndex: 0 })],
        signal,
      ),
  });
  setTimeout(() => w.stop.abort(), 30);
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  assert.equal(run.verdict, "broken");
  assert.equal(run.retired, true);
  assert.deepEqual(w.calls, [
    "create",
    `cancel s1 ${TURN} +tasks`,
    "reset s1 Rollup: 2026-09-25-broken",
  ]);
  assert.equal(existsSync(w.file), false);
});

test("turn.failed cancels the turn's tasks, then resets: a failed turn leaves no task behind", async (t) => {
  const w = world(t, {
    events: () =>
      iterate([
        ev("turn.started"),
        ev("step.started", { stepIndex: 0 }),
        ev("turn.failed"),
        ev("session.waiting", { wait: "next-user-message" }),
      ]),
  });
  const run = await runNightTurn(w.ctx, "day", "2026-09-25");
  assert.equal(run.verdict, "failed");
  assert.equal(run.retired, true);
  assert.deepEqual(w.calls, [
    "create",
    `cancel s1 ${TURN} +tasks`,
    "reset s1 Rollup: 2026-09-25-failed",
  ]);
});

test("a completed turn and a cut turn are reset without a second cancel", async (t) => {
  const finished = world(t);
  await runNightTurn(finished.ctx, "day", "2026-09-25");
  assert.deepEqual(finished.calls, [
    "create",
    "reset s1 Rollup: 2026-09-25-completed",
  ]);
  const steps = Array.from({ length: NIGHT_MAX_STEPS + 1 }, (_, i) =>
    ev("step.started", { stepIndex: i }),
  );
  const cut = world(t, {
    events: () =>
      iterate([
        ev("turn.started"),
        ...steps,
        ev("turn.cancelled"),
        ev("session.waiting", { wait: "next-user-message" }),
      ]),
  });
  const run = await runNightTurn(cut.ctx, "day", "2026-09-25");
  assert.equal(run.verdict, "cut");
  assert.deepEqual(cut.calls, [
    "create",
    `cancel s1 ${TURN} +tasks`,
    "reset s1 Rollup: 2026-09-25-cut",
  ]);
});

test(
  "a hung cancel ends by the cancel deadline, the reset still follows, and the file is gone",
  { timeout: 3000 },
  async (t) => {
    const w = world(t, {
      events: (signal) =>
        hangAfter(
          [ev("turn.started"), ev("step.started", { stepIndex: 0 })],
          signal,
        ),
      cancel: hung,
    });
    setTimeout(() => w.stop.abort(), 10);
    const startedAt = Date.now();
    const run = await runNightTurn(w.ctx, "day", "2026-09-25");
    const elapsed = Date.now() - startedAt;
    assert.equal(run.retired, true);
    assert.ok(
      elapsed >= NIGHT_CANCEL_MS && elapsed < NIGHT_CANCEL_MS + 1000,
      `the cancel deadline ended it (${elapsed} ms)`,
    );
    assert.deepEqual(w.calls, [
      "create",
      `cancel s1 ${TURN} +tasks`,
      "reset s1 Rollup: 2026-09-25-broken",
    ]);
    assert.match(w.log.join("\n"), /cancel of turn turn_day: failed \(/u);
    assert.equal(existsSync(w.file), false);
  },
);

test(
  "a hung reset ends by the reset deadline: not retired, the file stays, the session is journaled",
  { timeout: 3000 },
  async (t) => {
    const w = world(t, { reset: (_id, signal) => hung(signal) });
    const startedAt = Date.now();
    const run = await runNightTurn(w.ctx, "day", "2026-09-25");
    const elapsed = Date.now() - startedAt;
    assert.equal(run.verdict, "completed");
    assert.equal(run.retired, false);
    assert.ok(
      elapsed >= NIGHT_RESET_MS && elapsed < NIGHT_RESET_MS + 1000,
      `the reset deadline ended it (${elapsed} ms)`,
    );
    assert.match(readFileSync(w.file, "utf8"), /"sessionId":"s1"/u);
    assert.deepEqual(w.abandoned, ["s1 2026-09-25-completed-reset-failed"]);
    assert.match(w.log.join("\n"), /was not reset .*aborted due to timeout/u);
  },
);

test(
  "a hung reset at start ends by its deadline after a bounded cancel: the start is refused, the file stays",
  { timeout: 3000 },
  async (t) => {
    const w = world(t, { cancel: hung, reset: (_id, signal) => hung(signal) });
    writeFileSync(
      w.file,
      JSON.stringify({ sessionId: "wrun_saved", createdAt: 1 }),
    );
    const startedAt = Date.now();
    assert.equal(await resetSavedSession(w.ctx), false);
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed >= NIGHT_CANCEL_MS + NIGHT_RESET_MS && elapsed < 2000,
      `both deadlines, one after the other (${elapsed} ms)`,
    );
    assert.deepEqual(w.calls, [
      "cancel wrun_saved (active) +tasks",
      "reset wrun_saved Rollup: crash",
    ]);
    assert.match(readFileSync(w.file, "utf8"), /wrun_saved/u);
  },
);
