/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Сбои последних суток из Trace без модели (spec-trace §3.2.1): окно, свёртка по причине, счёт
// разных ходов, что не берётся, строки для Insight и для diagnose. В конце PBT на мусоре и
// перестановке строк (seed в имени теста, повтор — FC_SEED=<seed>).
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";
import { injectionWarning } from "../../agent/lib/telegram-gate-notice.ts";
import {
  diagnoseFailureLines,
  failureReason,
  insightFailureLines,
  listTurnFailures,
  type TurnFailure,
} from "./turn-failures.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
const ROOT = mkdtempSync(join(tmpdir(), "iva-turn-failures-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-06T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

type Event = {
  ts?: string;
  turn?: string;
  session?: string;
  kind: string;
  name: string;
  data?: unknown;
};

const line = ({
  ts = iso(NOW - 60_000),
  turn = "",
  session = "",
  ...rest
}: Event) =>
  JSON.stringify({ ts, turn, session, source: "telegram", data: {}, ...rest });

let runs = 0;
/** Каталог данных с дневными файлами `{имя: строки}`. */
function journal(days: Record<string, readonly string[]>): string {
  const data = join(ROOT, `run-${runs++}`);
  mkdirSync(join(data, "trace"), { recursive: true });
  for (const [day, lines] of Object.entries(days))
    writeFileSync(join(data, "trace", `${day}.jsonl`), `${lines.join("\n")}\n`);
  return data;
}

const bash = (session: string, turn: string, stderr: string, ms = 60_000) =>
  line({
    ts: iso(NOW - ms),
    session,
    turn,
    kind: "eve",
    name: "action.result",
    data: {
      toolName: "bash",
      status: "completed",
      exitCode: 2,
      failure: "exit 2",
      result: JSON.stringify({ exitCode: 2, stderr, stdout: "" }),
    },
  });

const causes = (data: string) => listTurnFailures(data, NOW).causes;

test("window: now − 24 h − 1 ms is out, now − 24 h is in; a line of yesterday's file with today's UTC ts counts", () => {
  const failed = (ms: number, session: string) =>
    line({
      ts: iso(NOW - ms),
      session,
      turn: "turn_0",
      kind: "eve",
      name: "turn.failed",
      data: { code: "X", message: "boom" },
    });
  const data = journal({
    "2026-10-05": [failed(DAY_MS + 1, "s-out"), failed(DAY_MS, "s-in")],
    "2026-10-06": [failed(60_000, "s-today")],
  });
  const [cause] = causes(data);
  assert.equal(cause?.count, 2);
  assert.equal(cause?.ref, "s-today/turn_0");
  assert.equal(causes(data).length, 1);
});

test("only the two newest day files are read", () => {
  const failed = line({
    session: "s",
    turn: "turn_0",
    kind: "eve",
    name: "turn.failed",
    data: { code: "OLD" },
  });
  const data = journal({
    "2026-10-04": [failed],
    "2026-10-05": [],
    "2026-10-06": [],
  });
  assert.deepEqual(causes(data), []);
});

test("turn.failed and step.failed of one turn with the same code and message are one cause counted once", () => {
  const data = journal({
    "2026-10-06": ["turn.failed", "step.failed"].map((name) =>
      line({
        session: "s",
        turn: "turn_4",
        kind: "eve",
        name,
        data: { code: "MODEL_CALL_FAILED", message: "429 busy" },
      }),
    ),
  });
  assert.deepEqual(causes(data), [
    {
      where: "turn",
      kind: "MODEL_CALL_FAILED",
      reason: "429 busy",
      ref: "s/turn_4",
      at: NOW - 60_000,
      count: 1,
    },
  ]);
});

test("three bash failures in two turns are «2×», the newest turn is named", () => {
  const data = journal({
    "2026-10-06": [
      bash("a", "turn_0", "ls: /x: No such file", 300_000),
      bash("a", "turn_0", "ls: /x: No such file", 200_000),
      bash("b", "turn_1#planner", "ls: /x: No such file", 100_000),
    ],
  });
  const lines = insightFailureLines(causes(data));
  assert.deepEqual(lines, [
    "2× bash · exit 2 · ls: /x: No such file · last 09:58 UTC · iva trace show b/turn_1",
  ]);
});

test("not taken: tool.rejected, gate, bridge.dropped, Stop of the owner, a call without failure, an old-format result", () => {
  const data = journal({
    "2026-10-06": [
      line({
        kind: "tool",
        name: "rejected",
        data: { tool: "bash", errorHead: "x" },
      }),
      line({ kind: "gate", name: "inbound", data: { blocked: true } }),
      line({ kind: "bridge", name: "dropped", data: {} }),
      line({
        session: "s",
        turn: "turn_0",
        kind: "stop",
        name: "requested",
        data: {},
      }),
      line({
        session: "s",
        turn: "turn_0",
        kind: "eve",
        name: "turn.cancelled",
        data: {},
      }),
      line({
        session: "s",
        turn: "turn_0",
        kind: "eve",
        name: "action.result",
        data: { toolName: "grep", exitCode: 1, result: '{"exitCode":1}' },
      }),
      line({
        session: "s",
        turn: "turn_0",
        kind: "eve",
        name: "action.result",
        data: { toolName: "bash", isError: true, result: { stderr: "old" } },
      }),
    ],
  });
  assert.deepEqual(causes(data), []);
});

test("guard.repeat_stop is a cause with no turn; stop.failed without a session names no turn, never a bare turn_N", () => {
  const data = journal({
    "2026-10-06": [
      line({
        kind: "guard",
        name: "repeat_stop",
        data: { tool: "web_fetch", errorHead: "403 Forbidden", count: 3 },
      }),
      line({
        turn: "turn_3",
        kind: "stop",
        name: "failed",
        data: { error: "no run" },
      }),
    ],
  });
  const lines = insightFailureLines(causes(data));
  assert.equal(lines.length, 2);
  assert.ok(
    lines.includes(
      "1× web_fetch · repeat ×3 · 403 Forbidden · last 09:59 UTC · no turn in the Trace",
    ),
  );
  assert.ok(
    lines.includes(
      "1× stop · failed · no run · last 09:59 UTC · no turn in the Trace",
    ),
  );
  assert.ok(lines.every((l) => !l.includes("turn_3")));
});

test("a failure in a session whose prompt starts with «Insight:» gives no line", () => {
  const data = journal({
    "2026-10-05": [
      line({
        ts: iso(NOW - 2 * DAY_MS + 3_600_000),
        session: "ins",
        turn: "turn_0",
        kind: "eve",
        name: "message.received",
        data: { message: "Insight: once a day…" },
      }),
    ],
    "2026-10-06": [bash("ins", "turn_0", "403"), bash("chat", "turn_0", "403")],
  });
  assert.deepEqual(
    causes(data).map((cause) => cause.ref),
    ["chat/turn_0"],
  );
});

test("an Insight prompt behind the Gate warning is still Insight: its failure gives no line", () => {
  const data = journal({
    "2026-10-06": [
      line({
        session: "insw",
        turn: "turn_0",
        kind: "eve",
        name: "message.received",
        data: { message: `${injectionWarning()}\n\nInsight: once a day…` },
      }),
      bash("insw", "turn_0", "403"),
      bash("chat", "turn_0", "403"),
    ],
  });
  assert.deepEqual(
    causes(data).map((cause) => cause.ref),
    ["chat/turn_0"],
  );
});

test("numbers of any length fold into one cause: «attempt 9» and «attempt 12» are one line", () => {
  const data = journal({
    "2026-10-06": [
      bash("a", "turn_0", "fetch failed (attempt 9)"),
      bash("b", "turn_0", "fetch failed (attempt 12)"),
      bash("c", "turn_0", "fetch failed (attempt 100)"),
    ],
  });
  const all = causes(data);
  assert.equal(all.length, 1, JSON.stringify(all));
  assert.equal(all[0]?.count, 3);
});

test("a result cut from the end gives its leading error, never the content after it", () => {
  const cut = (result: string, session: string) =>
    line({
      session,
      turn: "turn_0",
      kind: "eve",
      name: "action.result",
      data: { toolName: "memory_search", failure: "ok:false", result },
    });
  const tail = `,"hits":[{"text":"OWNER_PRIVATE_NOTE ${"дневник ".repeat(500)}`;
  const bashCut = `{"exitCode":2,"stderr":"warn\\nls: nope\\n","stdout":"OWNER_PRIVATE_NOTE ${"x".repeat(100)}`;
  const lines = [
    cut(`{"ok":false,"error":"index busy"${tail}…[truncated]`, "a"),
    cut(`{"ok":false,"message":"no index"${tail}`, "b"),
    cut(`{"ok":false${tail}`, "c"),
    cut(bashCut, "d"),
  ].map((raw) => JSON.parse(raw) as Record<string, unknown>);
  assert.deepEqual(lines.map(failureReason), [
    "index busy",
    "no index",
    "",
    "ls: nope",
  ]);
});

test("load_skill and a subagent name the skill or the agent, not a bare «tool»", () => {
  const failed = (session: string, data: Record<string, unknown>) =>
    line({
      session,
      turn: "turn_0",
      kind: "eve",
      name: "action.result",
      data: { failure: "isError", ...data },
    });
  const data = journal({
    "2026-10-06": [
      failed("a", { name: "insgiht", result: "Skill not found" }),
      failed("b", { subagentName: "researcher", result: "no such agent" }),
    ],
  });
  assert.deepEqual(
    causes(data)
      .map((cause) => cause.where)
      .sort(),
    ["skill insgiht", "subagent researcher"],
  );
});

test("captureContent:false: the reason is empty, the line is there", () => {
  const data = journal({
    "2026-10-06": [
      line({
        session: "s",
        turn: "turn_0",
        kind: "eve",
        name: "action.result",
        data: {
          toolName: "bash",
          failure: "exit 2",
          exitCode: 2,
          resultChars: 80,
        },
      }),
    ],
  });
  assert.deepEqual(insightFailureLines(causes(data)), [
    "1× bash · exit 2 · last 09:59 UTC · iva trace show s/turn_0",
  ]);
});

test("12 causes: 10 lines and «… and 2 more causes»; none — []", () => {
  const data = journal({
    "2026-10-06": Array.from({ length: 12 }, (_, i) =>
      line({
        session: `s${i}`,
        turn: "turn_0",
        kind: "eve",
        name: "turn.failed",
        data: { code: `CODE_${"ABCDEFGHIJKL"[i]}` },
      }),
    ),
  });
  const lines = insightFailureLines(causes(data));
  assert.equal(lines.length, 11);
  assert.equal(lines.at(-1), "… and 2 more causes");
  assert.deepEqual(insightFailureLines([]), []);
});

test("diagnoseFailureLines carry the class and the turn, never the reason", () => {
  const data = journal({
    "2026-10-06": [bash("s", "turn_0", "OWNER-MARKER secret")],
  });
  const lines = diagnoseFailureLines(causes(data));
  assert.deepEqual(lines, [
    "- 1× bash · exit 2 · last 2026-10-06T09:59:00.000Z · s/turn_0",
  ]);
  assert.ok(lines.every((l) => !l.includes("OWNER-MARKER")));
});

test("failureReason: bash — the last stderr line; an error object — its message; a step — its message; not JSON — the first line", () => {
  const result = (output: unknown) => ({
    kind: "eve",
    name: "action.result",
    data: { failure: "x", result: JSON.stringify(output) },
  });
  assert.equal(
    failureReason(
      result({ exitCode: 2, stderr: "warn\nls: /x: No such file\n\n" }),
    ),
    "ls: /x: No such file",
  );
  assert.equal(
    failureReason(
      result({ ok: false, error: { code: "E", message: "bad   key" } }),
    ),
    "bad key",
  );
  assert.equal(failureReason(result({ ok: false, message: "m" })), "m");
  assert.equal(
    failureReason({
      kind: "eve",
      name: "action.result",
      data: { failure: "x", result: "Error\nmore" },
    }),
    "Error",
  );
  assert.equal(
    failureReason({
      kind: "eve",
      name: "action.result",
      data: { failure: "x", error: "own error", result: '{"error":"other"}' },
    }),
    "own error",
  );
  assert.equal(
    failureReason({
      kind: "eve",
      name: "step.failed",
      data: { message: "\n429 busy\nbody" },
    }),
    "429 busy",
  );
  assert.equal(
    failureReason({
      kind: "outbox",
      name: "failed",
      data: { error: "400 Bad Request" },
    }),
    "400 Bad Request",
  );
});

test("no trace folder — nothing; a folder that cannot be listed throws; broken lines are counted", () => {
  const empty = join(ROOT, "no-trace");
  mkdirSync(empty, { recursive: true });
  assert.deepEqual(listTurnFailures(empty, NOW), { causes: [], unreadable: 0 });
  const blocked = join(ROOT, "trace-is-a-file");
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(blocked, "trace"), "");
  assert.throws(() => listTurnFailures(blocked, NOW), /ENOTDIR/u);
  const data = journal({
    "2026-10-06": [
      "{not json",
      "[]",
      JSON.stringify({
        ts: iso(NOW),
        kind: "eve",
        name: "turn.failed",
        data: 1,
      }),
      JSON.stringify({
        ts: "yesterday",
        kind: "eve",
        name: "turn.failed",
        data: {},
      }),
      '{"ts":"2026-10-06T09:59:00.000Z","kind":"eve","na',
      bash("s", "turn_0", "x"),
    ],
  });
  const { causes: found, unreadable } = listTurnFailures(data, NOW);
  assert.equal(unreadable, 5);
  assert.equal(found.length, 1);
});

// --- PBT ---------------------------------------------------------------------------------

const id = fc.string({ maxLength: 200 });
const good = fc
  .record({
    ms: fc.integer({ min: 0, max: DAY_MS + 3_600_000 }),
    session: id,
    turn: fc.oneof(id, fc.constantFrom("turn_0", "turn_1", "turn_2#sub")),
    pick: fc.integer({ min: 0, max: 4 }),
    tool: fc.string({ maxLength: 4096 }),
    reason: fc.string({ maxLength: 300 }),
    code: fc.oneof(fc.string({ maxLength: 80 }), fc.integer()),
  })
  .map(({ ms, session, turn, pick, tool, reason, code }) => {
    const ts = iso(NOW - ms);
    const events: Event[] = [
      { kind: "eve", name: "turn.failed", data: { code, message: reason } },
      {
        kind: "eve",
        name: "action.result",
        data: {
          toolName: tool,
          failure: `exit ${String(code).length}`,
          result: reason,
        },
      },
      { kind: "outbox", name: "failed", data: { error: reason } },
      {
        kind: "guard",
        name: "repeat_stop",
        data: { tool, errorHead: reason, count: 2 },
      },
      {
        kind: "eve",
        name: "message.received",
        data: { message: `Insight: ${reason}` },
      },
    ];
    return JSON.stringify({ ts, turn, session, source: "x", ...events[pick] });
  });
const garbage = fc.oneof(
  fc.jsonValue().map((value) => JSON.stringify(value)),
  fc.string(),
  good.map((value) => value.slice(0, Math.floor(value.length / 2))),
);

test(`PBT: garbage among events — no throw, at most 11 lines, no newline, the ref whole, ≤ 200 with a reason, any order the same (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(good, good, garbage), { maxLength: 40 }),
      fc.integer({ min: 0, max: 39 }),
      (lines, cut) => {
        const one = journal({ "2026-10-06": lines });
        const { causes: found } = listTurnFailures(one, NOW);
        const printed = insightFailureLines(found);
        assert.ok(printed.length <= 11);
        found.slice(0, 10).forEach((cause: TurnFailure, i) => {
          const text = printed[i] ?? "";
          assert.ok(!text.includes("\n"));
          assert.ok(cause.count >= 1);
          assert.ok(
            text.includes(
              cause.ref
                ? `iva trace show ${cause.ref}`
                : "no turn in the Trace",
            ),
          );
          const open = cause.ref
            ? `iva trace show ${cause.ref}`
            : "no turn in the Trace";
          const bare = `${cause.count}× ${cause.where} · ${cause.kind} · last ${iso(cause.at).slice(11, 16)} UTC · ${open}`;
          if (text.length > 200) assert.equal(text, bare);
        });
        for (const text of printed) assert.ok(!text.includes("\n"));
        const shuffled = [
          ...lines.slice(cut),
          ...lines.slice(0, cut),
        ].reverse();
        const two = journal({ "2026-10-06": shuffled });
        assert.deepEqual(listTurnFailures(two, NOW).causes, found);
      },
    ),
    { seed: SEED, numRuns: 100 },
  );
});
