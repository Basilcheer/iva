/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Свойства журнала хода на случайных событиях. Якоря контракта — в trace.test.ts,
// здесь генератор кормит писателя тем, что реально прилетает из чужих payload: юникод-
// мусор, одинокие суррогаты, гигантские аргументы тула, циклы, bigint, битые геттеры.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

const root = mkdtempSync(join(tmpdir(), "iva-trace-pbt-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_TIMEZONE = "UTC";
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const {
  appendTrace,
  capTraceString,
  capTraceTail,
  pruneTrace,
  traceDir,
  traceFilePath,
  traceLine,
  TRACE_CONTENT_FALLBACK,
  TRACE_CONTENT_LIMIT,
  TRACE_ID_LIMIT,
  TRACE_LINE_LIMIT,
  TRACE_TRUNCATION_MARKER,
} = await import("./trace.ts");

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const RUNS = { numRuns: 200 };
const SCHEMA = ["ts", "turn", "session", "source", "kind", "name", "data"];

// Текст, каким он приходит из чужого payload: любые кодовые единицы, включая одинокие
// суррогаты (их даёт склейка обрезанных строк выше по стеку).
const wildText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 200 }),
  fc.string({ unit: "grapheme", maxLength: 200 }),
  fc.constantFrom("\ud800", "\udfff", "a\ud800b", "🙂".repeat(3)),
  fc
    .tuple(
      fc.integer({ min: 1990, max: 6000 }),
      fc.string({ unit: "grapheme", maxLength: 4 }),
    )
    .map(([size, seed]) => (seed || "x").repeat(size)),
);

// Объекты, которых генератор fast-check не делает, а чужой payload приносит: цикл,
// падающий геттер, падающий toJSON. Фабрика вызывается на каждом прогоне, поэтому
// экземпляр всегда свежий.
const hostileObject = fc
  .constantFrom<() => unknown>(
    () => {
      const cycle: Record<string, unknown> = { name: "cycle" };
      cycle.self = cycle;
      return cycle;
    },
    () => ({
      get boom(): unknown {
        throw new Error("getter");
      },
    }),
    () => ({
      toJSON() {
        throw new Error("toJSON");
      },
    }),
    () => Buffer.alloc(4096),
    () => new Date("2026-08-17T10:20:30.000Z"),
    () => new Error("provider refused"),
    () => new Map([["a", 1]]),
  )
  .map((make) => make());

const wildValue = fc.oneof(
  wildText,
  hostileObject,
  fc.anything({
    withBigInt: true,
    withDate: true,
    withMap: true,
    withSet: true,
    withNullPrototype: true,
    withObjectString: true,
    maxDepth: 3,
  }),
);

const record = fc.dictionary(fc.string({ maxLength: 12 }), wildValue, {
  maxKeys: 5,
});

const event = fc.record({
  kind: fc.string({ unit: "grapheme", maxLength: 300 }),
  name: fc.string({ unit: "grapheme", maxLength: 300 }),
  turn: fc.option(wildText, { nil: undefined }),
  session: fc.option(wildText, { nil: undefined }),
  source: fc.option(wildText, { nil: undefined }),
  data: fc.option(record, { nil: undefined }),
  // До 8 полей содержимого по 6000 знаков: событие заведомо перерастает потолок строки,
  // и ветка «пересобрать без содержимого» получает свои прогоны.
  content: fc.option(
    fc.dictionary(
      fc.string({ maxLength: 12 }),
      fc.oneof(
        { weight: 3, arbitrary: wildText },
        {
          weight: 1,
          arbitrary: fc
            .tuple(
              fc.integer({ min: 1000, max: 6000 }),
              fc.constantFrom("я", "x", "🙂"),
            )
            .map(([size, unit]) => unit.repeat(size)),
        },
      ),
      { maxKeys: 8 },
    ),
    {
      nil: undefined,
    },
  ),
});

const AT = new Date("2026-08-17T10:20:30.000Z");

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) strings(item, out);
  return out;
}

test("property: любое событие даёт одну валидную JSON-строку фиксированной схемы", () => {
  fc.assert(
    fc.property(event, (input) => {
      const line = traceLine(input, { now: AT, captureContent: true });

      assert.equal(line.includes("\n"), false);
      assert.ok(Buffer.byteLength(line, "utf8") <= TRACE_LINE_LIMIT);
      const parsed = parse(line);
      assert.deepEqual(Object.keys(parsed), SCHEMA);
      assert.equal(parsed.ts, "2026-08-17T10:20:30.000Z");
      assert.equal(parsed.kind, capTraceString(input.kind, TRACE_ID_LIMIT));
      assert.equal(parsed.name, capTraceString(input.name, TRACE_ID_LIMIT));
      assert.equal(
        parsed.turn,
        capTraceString(input.turn ?? "", TRACE_ID_LIMIT),
      );
      assert.equal(
        parsed.session,
        capTraceString(input.session ?? "", TRACE_ID_LIMIT),
      );
      assert.equal(
        parsed.source,
        capTraceString(input.source ?? "", TRACE_ID_LIMIT),
      );
      assert.equal(typeof parsed.data, "object");
      assert.notEqual(parsed.data, null);
    }),
    RUNS,
  );
});

test("property: содержимое обрезано по потолку и помечено обрезкой", () => {
  fc.assert(
    fc.property(event, (input) => {
      const parsed = parse(traceLine(input, { now: AT, captureContent: true }));
      const data = parsed.data as Record<string, unknown>;

      // Ни одна строка в событии не длиннее потолка — включая вложенные.
      for (const text of strings(data))
        assert.ok(text.length <= TRACE_CONTENT_LIMIT);

      // Эталон: то же событие без содержимого вовсе. Ключ содержимого может совпасть с
      // ключом data — тогда значение в строке законно и приходит из data, а не из
      // выброшенного содержимого.
      const bare = parse(
        traceLine(
          { ...input, content: undefined },
          { now: AT, captureContent: true },
        ),
      ).data as Record<string, unknown>;

      for (const [key, value] of Object.entries(input.content ?? {})) {
        // Событие, не влезшее в строку даже после обрезки полей, едет без содержимого.
        // Размеры при этом остаются: имена, тайминги и размеры выбрасываются последними.
        if (data.traceTrimmed === true) {
          if (bare[key] === undefined) assert.equal(data[key], undefined);
          assert.equal(data[`${key}Chars`], value.length);
          continue;
        }
        assert.equal(data[`${key}Chars`], value.length);
        // Поле режется по 4096, а строка, не влезшая с ним, — по 2000; больше ничем.
        assert.ok(
          [
            capTraceString(value, TRACE_CONTENT_LIMIT),
            capTraceString(value, TRACE_CONTENT_FALLBACK),
          ].includes(String(data[key])),
        );
      }
    }),
    RUNS,
  );
});

test("property: captureContent=false не пропускает содержимое, но оставляет размеры", () => {
  fc.assert(
    fc.property(event, (input) => {
      const data = parse(traceLine(input, { now: AT, captureContent: false }))
        .data as Record<string, unknown>;

      // Событие без содержимого вовсе — эталон. Выключенный тумблер обязан дать ровно
      // его же плюс размеры: сравнение с эталоном ловит и утечку значения, и случай,
      // когда ключ содержимого совпал с ключом data (тогда значение из data — законно).
      // Эталон собран с теми же размерами в data: строка проходит те же ступени обрезки.
      const sizes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.content ?? {}))
        sizes[`${key}Chars`] = value.length;
      const expected = parse(
        traceLine(
          { ...input, data: { ...input.data, ...sizes }, content: undefined },
          { now: AT, captureContent: false },
        ),
      ).data as Record<string, unknown>;

      assert.deepEqual(data, expected);
    }),
    RUNS,
  );
});

// Поле 4096 не теряет того, что держало поле 2000. Старое поведение воспроизводится тем
// же писателем: содержимое заранее обрезано по 2000, а data без длинных строк, поэтому
// первая попытка на нём — ровно строка до правки.
test("property: событие, которое при 2000 сохраняло содержимое, сохраняет его и теперь", () => {
  const sized = fc
    .tuple(
      fc.integer({ min: 500, max: 6000 }),
      fc.constantFrom("я", "x", "🙂", "\u0f00"),
    )
    .map(([size, unit]) => unit.repeat(size));
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ maxLength: 12 }), sized, { maxKeys: 8 }),
      fc.dictionary(fc.string({ maxLength: 12 }), fc.integer(), {
        maxKeys: 5,
      }),
      (content, data) => {
        const input = { kind: "eve", name: "action.result", data, content };
        const old = Object.fromEntries(
          Object.entries(content).map(([key, value]) => [
            key,
            capTraceString(value, TRACE_CONTENT_FALLBACK),
          ]),
        );
        const options = { now: AT, captureContent: true };
        const before = parse(traceLine({ ...input, content: old }, options))
          .data as Record<string, unknown>;
        const after = parse(traceLine(input, options)).data as Record<
          string,
          unknown
        >;
        if (before.traceTrimmed !== true)
          assert.notEqual(after.traceTrimmed, true);
      },
    ),
    RUNS,
  );
});

test("property: capTraceTail оставляет конец, пометку в начале и не рвёт пару", () => {
  fc.assert(
    fc.property(
      // Целые знаки: пары суррогатов на любом месте, включая место среза.
      fc.oneof(
        fc.string({ unit: "grapheme", maxLength: 400 }),
        fc.nat(200).map((size) => "a🙂".repeat(size)),
      ),
      fc.integer({ min: TRACE_TRUNCATION_MARKER.length, max: 500 }),
      (value, limit) => {
        const kept = capTraceTail(value, limit);
        assert.ok(kept.length <= limit);
        if (kept === value) return;
        assert.ok(kept.startsWith(TRACE_TRUNCATION_MARKER));
        const tail = kept.slice(TRACE_TRUNCATION_MARKER.length);
        assert.ok(value.endsWith(tail));
        assert.equal(/^[\udc00-\udfff]/u.test(tail), false);
      },
    ),
    RUNS,
  );
});

// Смещение дня в UTC — тот же расчёт, что у писателя, но записанный тестом отдельно:
// граница окна проверяется числами, а не повтором продовой строки.
function shift(day: string, delta: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

test("property: чистка удаляет по дате в имени и не трогает чужие файлы", () => {
  const today = fc
    .date({
      min: new Date("2020-01-01T00:00:00Z"),
      max: new Date("2035-01-01T00:00:00Z"),
      noInvalidDate: true,
    })
    .map((value) => value.toISOString().slice(0, 10));
  // Смещения вокруг границы окна (-29) — иначе случайная дата за 15 лет попадает
  // ровно в край раз в тысячу прогонов, и off-by-one живёт в проде.
  const offsets = fc.uniqueArray(fc.integer({ min: -40, max: 2 }), {
    maxLength: 12,
  });
  const foreign = fc.constantFrom(
    "notes.md",
    "2026-08-05.jsonl.bak",
    "trace.jsonl",
    "20260805.jsonl",
    "2026-08-05.json",
  );

  fc.assert(
    fc.property(
      today,
      offsets,
      fc.uniqueArray(foreign, { maxLength: 3 }),
      (day, deltas, others) => {
        const dir = mkdtempSync(join(root, "prune-"));
        mkdirSync(traceDir(dir), { recursive: true });
        const days = deltas.map((delta) => shift(day, delta));
        for (const value of days)
          writeFileSync(join(traceDir(dir), `${value}.jsonl`), "");
        for (const name of others) writeFileSync(join(traceDir(dir), name), "");

        const removed = pruneTrace(dir, day);
        const left = new Set(readdirSync(traceDir(dir)));

        for (const name of others) assert.ok(left.has(name));
        // Окно — сегодняшний файл и 29 предыдущих; всё, что старше ПО ИМЕНИ, в утиль.
        const cutoff = shift(day, -29);
        for (const value of days) {
          const name = `${value}.jsonl`;
          const keep = value >= cutoff;
          assert.equal(left.has(name), keep);
          assert.equal(removed.includes(name), !keep);
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("property: писатель не кидает ни на каком входе", (t) => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  t.after(() => {
    console.error = original;
  });

  const cyclic: Record<string, unknown> = { name: "cycle" };
  cyclic.self = cyclic;
  const hostile: Record<string, unknown>[] = [
    cyclic,
    {
      get boom() {
        throw new Error("getter");
      },
    },
    { big: 10n ** 40n, fn: () => 1, sym: Symbol("s"), undef: undefined },
    { deep: [[[[[["bottom"]]]]]] },
    { huge: "я".repeat(100_000) },
    {
      toJSON: () => {
        throw new Error("toJSON");
      },
    },
  ];

  const dir = mkdtempSync(join(root, "safe-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const dataDir = join(dir, "data");

  for (const data of hostile) {
    assert.doesNotThrow(() =>
      appendTrace(
        { kind: "eve", name: "action.result", data },
        { dir: dataDir, now: AT },
      ),
    );
  }
  // Сломанное назначение записи: каталога нет, а на месте журнала лежит файл.
  assert.doesNotThrow(() =>
    appendTrace(
      { kind: "eve", name: "turn.started" },
      { dir: join(dir, "gone"), now: AT },
    ),
  );
  const blocked = mkdtempSync(join(root, "blocked-"));
  mkdirSync(join(blocked, "data"), { recursive: true });
  writeFileSync(traceDir(join(blocked, "data")), "file, not a directory");
  assert.doesNotThrow(() =>
    appendTrace(
      { kind: "eve", name: "turn.started" },
      { dir: join(blocked, "data"), now: AT },
    ),
  );

  // Всё, что не упало на сборке, обязано лежать в файле валидными строками.
  const written = readFileSync(traceFilePath("2026-08-17", dataDir), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.ok(written.length >= hostile.length - 2);
  for (const line of written) assert.doesNotThrow(() => parse(line));

  fc.assert(
    fc.property(event, (input) => {
      assert.doesNotThrow(() => appendTrace(input, { dir: dataDir, now: AT }));
    }),
    RUNS,
  );
});
