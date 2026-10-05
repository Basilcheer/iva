/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Insight на шве runProactiveTick (ADR-0022): слот `insightTimes` не в тихий час, заявка `insight.day`
// до хода, одно сообщение, имя черновика из кнопки «Поставить»/«Install» или метка «?», счёт
// непоставленных находок и неделя паузы. Одна строка таблицы отказов — один тест; в конце PBT (10)
// на тексте `data` кнопки (сид в имени теста, повтор — FC_SEED=<сид>).
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";

const ROOT = mkdtempSync(join(tmpdir(), "iva-proactive-insight-"));
process.env.ASSISTANT_DATA_DIR = join(ROOT, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { PROACTIVE_DEFAULTS } = await import("#lib/proactive-config.ts");
const { main, runProactiveTick } = await import("./tick.ts");
const { initialState, writeProactiveState } = await import("./state.ts");
import type { ProactiveConfig } from "#lib/proactive-config.ts";
import type { ReminderTurn } from "../lib/reminder-turn.ts";
import type { ProactiveState, InsightState } from "./state.ts";
import type { TickDeps } from "./tick.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY_MS = 24 * HOUR;
/** Зона владельца UTC+5; 2026-10-05 00:00 у него. */
const ZONE = "Asia/Tashkent";
const MIDNIGHT = Date.UTC(2026, 9, 4, 19, 0);
const at = (hh: number, mm = 0, days = 0) =>
  MIDNIGHT + days * DAY_MS + hh * HOUR + mm * MIN;
const DAY = "2026-10-05";
/** Brief выключен: окно утреннего слота (3 часа) иначе накрыло бы 11:30. */
const INSIGHT: ProactiveConfig = {
  ...PROACTIVE_DEFAULTS,
  briefTimes: [],
  insightTimes: ["11:30"],
};
const button = (data: string) =>
  `<tg-button-row><tg-button type="callback_data" data="${data}">x</tg-button></tg-button-row>`;
const found = (name: string) => `Нашла дело.\n${button(`Поставить ${name}`)}`;

type Harness = {
  readonly deps: TickDeps;
  readonly statePath: string;
  readonly events: string[];
  readonly prompts: string[];
  readonly sent: { part: string; source: string }[];
  readonly logs: string[];
  readonly installed: Set<string>;
  reply: ReminderTurn | Error;
  sendResult: { ok: boolean; error: string } | Error;
  failWrites: number[];
  installedThrows: boolean;
  config: ProactiveConfig;
  english: boolean;
  checks: number;
};

const turn = (message?: string, extra: Partial<ReminderTurn> = {}) =>
  ({
    status: "completed",
    message,
    feedback: () => Promise.resolve(),
    ...extra,
  }) as ReminderTurn;

function harness(): Harness {
  const h: Harness = {
    statePath: join(mkdtempSync(join(ROOT, "run-")), "proactive.json"),
    events: [],
    prompts: [],
    sent: [],
    logs: [],
    installed: new Set(),
    reply: turn(found("count-receipts")),
    sendResult: { ok: true, error: "" },
    failWrites: [],
    installedThrows: false,
    config: INSIGHT,
    english: false,
    checks: 0,
    deps: undefined as unknown as TickDeps,
  };
  let writes = 0;
  (h as { deps: TickDeps }).deps = {
    config: () => h.config,
    timeZone: ZONE,
    statePath: h.statePath,
    sources: [
      {
        name: "telegram",
        prefix: "tg:",
        check: () => {
          h.checks++;
          return Promise.resolve({ items: [], error: null });
        },
      },
    ],
    runTurn: (prompt) => {
      h.events.push("turn");
      h.prompts.push(prompt);
      return h.reply instanceof Error
        ? Promise.reject(h.reply)
        : Promise.resolve(h.reply);
    },
    send: (part, source) => {
      h.sent.push({ part, source });
      return h.sendResult instanceof Error
        ? Promise.reject(h.sendResult)
        : Promise.resolve(h.sendResult);
    },
    translate: () =>
      Promise.resolve((en: string, ru: string) => (h.english ? en : ru)),
    installed: (name) =>
      h.installedThrows
        ? Promise.reject(new Error("plugins.json damaged"))
        : Promise.resolve(h.installed.has(name)),
    writeState: (path, state) => {
      h.events.push(`write ${state.insight?.draft ?? "-"}`);
      return h.failWrites.includes(writes++)
        ? Promise.reject(new Error("ENOSPC"))
        : writeProactiveState(path, state);
    },
    log: (line) => h.logs.push(line),
  };
  return h;
}

const readState = (h: Harness) =>
  JSON.parse(readFileSync(h.statePath, "utf8")) as ProactiveState;
const insightOf = (h: Harness) => readState(h).insight;
const insights = (h: Harness) =>
  h.prompts.filter((p) => p.startsWith("Insight:"));
/** Прогоны уже были: файл есть; `insight` — по желанию. */
const seed = (h: Harness, insight?: InsightState) =>
  writeProactiveState(h.statePath, {
    ...initialState(at(0)),
    ...(insight ? { insight } : {}),
  });
const tick = (h: Harness, now: number) => runProactiveTick(now, h.deps);
const prev = (draft: string, misses = 0, day = DAY): InsightState => ({
  day,
  draft,
  misses,
  pausedUntilMs: 0,
});

test("1. insightTimes [] by default: no Insight at any time of the day", async () => {
  const h = harness();
  h.config = PROACTIVE_DEFAULTS;
  await seed(h);
  for (let m = 0; m < 24 * 60; m += 30) await tick(h, at(0, m));
  assert.equal(insights(h).length, 0);
  assert.equal(readState(h).insight, undefined);
});

test("2. the slot comes: the claim is written before the turn, the prompt follows the skill, one send as insight", async () => {
  const h = harness();
  await seed(h);
  assert.equal(await tick(h, at(11, 30)), 0);
  assert.deepEqual(h.events, ["write ", "turn", "write count-receipts"]);
  assert.match(h.prompts[0] ?? "", /^Insight: .*Follow the insight skill/u);
  assert.match(
    h.prompts[0] ?? "",
    /data="Поставить <name>".*data="Не надо <name>"/u,
  );
  assert.deepEqual(h.sent, [
    { part: found("count-receipts"), source: "insight" },
  ]);
  assert.deepEqual(insightOf(h), prev("count-receipts"));
  h.english = true;
  await seed(h);
  await tick(h, at(11, 30));
  assert.match(
    h.prompts[1] ?? "",
    /data="Install <name>".*data="Not now <name>"/u,
  );
});

test("3. a second run the same day makes no turn; the next day makes one", async () => {
  const h = harness();
  await seed(h);
  await tick(h, at(11, 30));
  await tick(h, at(12, 0));
  await tick(h, at(13, 30));
  assert.equal(insights(h).length, 1);
  await tick(h, at(11, 30, 1));
  assert.equal(insights(h).length, 2);
});

test("4. QUIET, empty or only separators: nothing is sent, exit 0, draft stays empty", async () => {
  for (const text of [
    "QUIET",
    "",
    "<!-- iva:next -->\n<!-- iva:next -->",
    "quiet.",
  ]) {
    const h = harness();
    await seed(h);
    h.reply = turn(text);
    assert.equal(await tick(h, at(11, 30)), 0);
    assert.deepEqual(h.sent, []);
    assert.equal(insightOf(h)?.draft, "");
  }
});

test("5. an answer in two parts goes out as one message", async () => {
  const h = harness();
  await seed(h);
  h.reply = turn(`Нашла дело.\n<!-- iva:next -->\n${button("Поставить a-b")}`);
  await tick(h, at(11, 30));
  assert.deepEqual(h.sent, [
    { part: `Нашла дело.\n\n${button("Поставить a-b")}`, source: "insight" },
  ]);
});

test("6. the claim not written: no turn, exit 1; a failed turn exits 0, logs and keeps the claim", async () => {
  const h = harness();
  await seed(h);
  h.failWrites = [0];
  assert.equal(await tick(h, at(11, 30)), 1);
  assert.equal(insights(h).length, 0);
  for (const reply of [
    new Error("502"),
    turn("x", { status: "failed" }),
    turn("x", { sessionLimit: true }),
    turn("x", { cancelled: true }),
  ]) {
    const f = harness();
    await seed(f);
    f.reply = reply;
    assert.equal(await tick(f, at(11, 30)), 0);
    assert.ok(f.logs.some((l) => l.includes("insight turn failed")));
    await tick(f, at(12, 0));
    assert.equal(insights(f).length, 1);
    assert.deepEqual(f.sent, []);
  }
});

test("7. send refused or threw: exit 0, draft stays empty", async () => {
  for (const result of [{ ok: false, error: "403" }, new Error("net")]) {
    const h = harness();
    await seed(h);
    h.sendResult = result;
    assert.equal(await tick(h, at(11, 30)), 0);
    assert.equal(insightOf(h)?.draft, "");
  }
});

test("8. the draft name from the Install button, else «?»; the second write failing still exits 0", async () => {
  const cases: [string, string, boolean?][] = [
    [found("x-y"), "x-y"],
    [`Found.\n${button("Install x-y")}`, "x-y"],
    ["Нашла дело, кнопку забыла.", "?"],
    [found("x-y").replaceAll('"', "'"), "?"],
    [found("x-y"), "?", true],
  ];
  for (const [text, draft, alreadyInstalled] of cases) {
    const h = harness();
    await seed(h);
    h.reply = turn(text);
    if (alreadyInstalled) h.installed.add("x-y");
    await tick(h, at(11, 30));
    assert.equal(insightOf(h)?.draft, draft, text);
  }
  const h = harness();
  await seed(h);
  h.failWrites = [1];
  assert.equal(await tick(h, at(11, 30)), 0);
  assert.equal(insightOf(h)?.draft, "");
});

test("9. the count: not installed +1, installed 0, a throwing check +1, «?» +1, QUIET unchanged; two misses — a week of pause", async () => {
  const misses = async (
    insight: InsightState,
    setup: (h: Harness) => void = () => {},
  ) => {
    const h = harness();
    await seed(h, { ...insight, day: "2026-10-04" });
    setup(h);
    await tick(h, at(11, 30));
    return insightOf(h)?.misses;
  };
  assert.equal(await misses(prev("a", 0)), 1);
  assert.equal(await misses(prev("a", 1), (h) => h.installed.add("a")), 0);
  assert.equal(
    await misses(prev("a", 0), (h) => (h.installedThrows = true)),
    1,
  );
  assert.equal(await misses(prev("?", 0), (h) => h.installed.add("?")), 1);
  assert.equal(await misses(prev("", 1)), 1);
  const h = harness();
  await seed(h, prev("a", 1, "2026-10-04"));
  assert.equal(await tick(h, at(12, 0)), 0);
  assert.equal(insights(h).length, 0);
  assert.deepEqual(insightOf(h), {
    day: DAY,
    draft: "",
    misses: 0,
    pausedUntilMs: at(12, 0) + 7 * DAY_MS,
  });
  await tick(h, at(11, 59, 7));
  assert.equal(insights(h).length, 0);
  await tick(h, at(12, 0, 7));
  assert.equal(insights(h).length, 1);
  assert.equal(insightOf(h)?.misses, 0);
});

test("10. a Brief in this run: Insight waits for the next run; an Insight run polls no Watch source", async () => {
  const h = harness();
  h.config = { ...INSIGHT, briefTimes: ["08:30"], insightTimes: ["08:30"] };
  await seed(h);
  await tick(h, at(8, 30));
  assert.deepEqual(
    h.prompts.map((p) => p.slice(0, 6)),
    ["Brief:"],
  );
  const checks = h.checks;
  await tick(h, at(9, 0));
  assert.equal(insights(h).length, 1);
  assert.equal(h.checks, checks);
});

test("11. the first run (no file): no Insight, Watch looks at the sources", async () => {
  const h = harness();
  await tick(h, at(11, 30));
  assert.equal(insights(h).length, 0);
  assert.equal(h.checks, 1);
});

test("12. the toggle off: no Insight", async () => {
  const h = harness();
  h.config = { ...INSIGHT, enabled: false };
  await seed(h);
  await tick(h, at(11, 30));
  assert.equal(insights(h).length, 0);
});

test("13. Watch and Brief runs after an Insight keep insight byte for byte", async () => {
  const h = harness();
  await seed(h);
  await tick(h, at(11, 30));
  const before = JSON.stringify(insightOf(h));
  h.config = { ...INSIGHT, briefTimes: ["14:00"] };
  await tick(h, at(13, 0));
  await tick(h, at(14, 0));
  assert.ok(h.prompts.some((p) => p.startsWith("Brief:")));
  assert.equal(JSON.stringify(insightOf(h)), before);
});

test("14. quiet hours: a 23:00 slot makes no turn; a 22:00 slot runs at 22:30, not at 23:30", async () => {
  const quiet = harness();
  quiet.config = { ...INSIGHT, insightTimes: ["23:00"] };
  await seed(quiet);
  await tick(quiet, at(23, 0));
  assert.equal(insights(quiet).length, 0);
  const late = harness();
  late.config = { ...INSIGHT, insightTimes: ["22:00"] };
  await seed(late);
  await tick(late, at(23, 30));
  assert.equal(insights(late).length, 0);
  await tick(late, at(22, 30));
  assert.equal(insights(late).length, 1);
});

test("15. after a break the old count does not hold: an insight a month old gives a turn, misses 0", async () => {
  const h = harness();
  await seed(h);
  await tick(h, at(11, 30));
  await tick(h, at(11, 30, 1));
  assert.equal(insightOf(h)?.misses, 1);
  await seed(h, { ...prev("count-receipts", 1), day: "2026-09-05" });
  await tick(h, at(11, 30, 2));
  assert.equal(insights(h).length, 3);
  assert.deepEqual(insightOf(h), {
    ...prev("count-receipts", 0),
    day: "2026-10-07",
  });
});

test("16. the pause not written: no turn, exit 1, the file as it was", async () => {
  const h = harness();
  await seed(h, prev("a", 1, "2026-10-04"));
  h.failWrites = [0];
  assert.equal(await tick(h, at(11, 30)), 1);
  assert.equal(insights(h).length, 0);
  assert.deepEqual(insightOf(h), prev("a", 1, "2026-10-04"));
});

test("17. main asks data/custom/plugins.json: a plugin there, even switched off, is installed; no file, a damaged one or another name — not", async () => {
  const data = process.env.ASSISTANT_DATA_DIR ?? "";
  const plugins = join(data, "custom", "plugins.json");
  const entry = {
    name: "count-receipts",
    source: "data/custom/plugin-drafts/count-receipts",
    ref: "",
    sha: "",
    digest: "",
    enabled: false,
    trusted: false,
    installedAt: "2026-10-04T12:00:00.000Z",
  };
  const run = async (file: string | null) => {
    rmSync(plugins, { force: true });
    mkdirSync(dirname(plugins), { recursive: true });
    if (file !== null) writeFileSync(plugins, file);
    await writeProactiveState(join(data, "proactive.json"), {
      ...initialState(at(0)),
      insight: prev("count-receipts", 1, "2026-10-04"),
    });
    const prompts: string[] = [];
    const env = {
      TELEGRAM_BOT_TOKEN: "123456:secret",
      TELEGRAM_ALLOWED_USER_IDS: "777",
      ASSISTANT_TIMEZONE: ZONE,
    };
    const code = await main(
      env,
      {
        config: () => INSIGHT,
        sources: [],
        runTurn: (prompt) => {
          prompts.push(prompt);
          return Promise.resolve(turn("QUIET"));
        },
        send: () => Promise.resolve({ ok: true, error: "" }),
        translate: () => Promise.resolve((_en: string, ru: string) => ru),
        log: () => {},
      },
      () => at(11, 30),
    );
    const insight = (
      JSON.parse(
        readFileSync(join(data, "proactive.json"), "utf8"),
      ) as ProactiveState
    ).insight;
    return {
      code,
      turns: prompts.length,
      paused: insight?.pausedUntilMs !== 0,
    };
  };
  const state = (list: unknown[]) =>
    JSON.stringify({ marketplaces: [], plugins: list });
  const ran = { code: 0, turns: 1, paused: false };
  const pausedRun = { code: 0, turns: 0, paused: true };
  assert.deepEqual(await run(state([entry])), ran);
  assert.deepEqual(await run(null), pausedRun);
  assert.deepEqual(await run("{ not json"), pausedRun);
  assert.deepEqual(
    await run(state([{ ...entry, name: "count-other" }])),
    pausedRun,
  );
});

test(`(10) any button data: every delivered Insight gets a non-empty draft, a name only by the pattern and within 64 bytes (seed ${SEED})`, async () => {
  const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
  const data = fc.oneof(
    fc.string({ unit: "grapheme", maxLength: 80 }),
    fc.stringMatching(/^[a-z0-9-]{0,45}$/u),
    fc.constantFrom(
      "../etc",
      "A-B",
      "x'y",
      'x"y',
      "a".repeat(41),
      "a".repeat(40),
    ),
  );
  await fc.assert(
    fc.asyncProperty(
      data,
      fc.constantFrom("Поставить", "Install"),
      async (name, word) => {
        const h = harness();
        await seed(h);
        h.reply = turn(`Нашла.\n${button(`${word} ${name}`)}`);
        await tick(h, at(11, 30));
        if (h.sent.length === 0) return;
        const draft = insightOf(h)?.draft ?? "";
        assert.notEqual(draft, "");
        if (draft === "?") return;
        assert.match(draft, NAME);
        assert.ok(Buffer.byteLength(`Поставить ${draft}`) <= 64);
      },
    ),
    { seed: SEED, numRuns: 100 },
  );
});
