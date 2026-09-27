// Чистая половина ночи: property-тесты с печатью seed (fast-check) и якоря контрактов.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import "../lib/ts-esm-hooks.ts";
const {
  canonicalHash,
  markedDone,
  parseDay,
  parseJson,
  prefixHash,
  quoteBelongsTo,
  summaryEdited,
  summaryText,
} = await import("./night-input.ts");
const { disappearedLines, logFactKey, sanitizeField, truthOf, withTruth } =
  await import("../../agent/lib/card-store.ts");
const { periodChildIds, periodChildren } = await import("./night-periods.ts");
const { buildVaultGraph } = await import("./graph.ts");
const { resolveStopAt } = await import("../lib/rollup-turn.ts");
const { NIGHT_CEILING, PART_SIZE } =
  await import("../../agent/lib/memory-night-constants.ts");

const SEED = 20_260_927;
const CHECKS = { seed: SEED, numRuns: 200, endOnFailure: true } as const;
const line = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter(
    (value) =>
      !/[\n\r]/u.test(value) && value.trim() === value && value.length > 0,
  );
const owner = (text: string) => ({
  id: "e1",
  time: "10:00",
  type: "[text]",
  text,
  origin: "owner" as const,
});

void test(`разбор дня: поддельный заголовок внутри реплики не рождает реплику (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({ min: 0, max: 23 }), line), {
        minLength: 1,
        maxLength: 15,
      }),
      (rows) => {
        const raw = rows
          .map(
            ([hour, body]) =>
              `## ${String(hour).padStart(2, "0")}:00 [text]\n${body}\n<!-- ## 10:00 fake -->`,
          )
          .join("\n\n");
        assert.deepEqual(
          parseDay(raw).map((entry) => entry.id),
          rows.map((_, index) => `e${index + 1}`),
        );
      },
    ),
    CHECKS,
  );
});

void test(`отметка ночи не меняет разбор и отпечаток префикса, в том числе с пробелами (ДЕФ-11, seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(line, { minLength: 1, maxLength: 10 }),
      fc.constantFrom("", " ", "  \n"),
      (bodies, tail) => {
        const raw =
          bodies.map((body) => `## 10:00 [text]\n${body}\n`).join("\n") + tail;
        const marked = `${raw}\n<!-- processed: memory-night 2026-09-26 -->\n`;
        const entries = parseDay(raw);
        assert.equal(
          prefixHash(parseDay(marked), entries.length),
          prefixHash(entries, entries.length),
        );
        assert.equal(markedDone(marked), true);
        assert.equal(markedDone(`${marked}\n## 11:00 [text]\nхвост\n`), false);
      },
    ),
    CHECKS,
  );
});

void test("реплики [queued] — владельца, [iva] и пересланное — нет (ДЕФ-10)", () => {
  const origins = parseDay(
    "## 10:00 [queued]\nмоё\n## 10:01 [iva]\nответ\n## 10:02 [text]\n[forwarded from @x]\nчужое\n## 10:03 [text]\nсвоё\n",
  ).map((e) => e.origin);
  assert.deepEqual(origins, ["owner", "iva", "forwarded", "owner"]);
});

void test(`канонический hash не зависит от порядка ключей (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue()),
      (record) => {
        assert.equal(
          canonicalHash(record),
          canonicalHash(Object.fromEntries(Object.entries(record).reverse())),
        );
      },
    ),
    CHECKS,
  );
});

void test(`sanitizeField: одна строка без frontmatter, фенсов и заголовков (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 600 }), (value) => {
      const clean = sanitizeField(`---\n# ${value}\n\`\`\``);
      assert.doesNotMatch(clean, /```|^---$|^#\s/mu);
      assert.ok(clean.length <= 500 && !clean.includes("\n"));
    }),
    CHECKS,
  );
});

void test(`цитата владельца переживает ё, тире и кавычки; реплика Ивы не источник (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.constantFrom('"', "«", "»", "„", "“"),
      fc.constantFrom("-", "–", "—"),
      (quote, dash) => {
        const text = `${quote}Ёлка ${dash} дом${quote}`;
        assert.equal(quoteBelongsTo(owner(text), '"елка — дом"'), true);
        assert.equal(
          quoteBelongsTo({ ...owner(text), origin: "iva" }, text),
          false,
        );
        assert.equal(quoteBelongsTo(owner(text), "чего не было"), false);
      },
    ),
    CHECKS,
  );
});

void test(`дедуп Log: факт с другим днём и указателем — тот же (seed ${SEED})`, () => {
  fc.assert(
    fc.property(line, (fact) => {
      assert.equal(
        logFactKey(`- 2026-09-26: ${fact} · [[daily/2026-09-26]] 10:00`),
        logFactKey(`- 2026-09-27: ${fact}`),
      );
    }),
    CHECKS,
  );
});

void test(`правда целиком: остальные разделы байт в байт, исчезнувшее = разница строк (ДЕФ-1, ДЕФ-18, seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(line, { minLength: 1, maxLength: 8 }),
      fc.uniqueArray(line, { maxLength: 8 }),
      (before, after) => {
        const tail = "## Log\n\n- 2026-09-26: факт\n\n## History\n";
        const body = `# Card\n\n${before.join("\n")}\n\n${tail}`;
        const next = withTruth(body, after.join("\n"));
        assert.equal(truthOf(next), after.join("\n"));
        assert.ok(next.endsWith(tail));
        assert.ok(next.startsWith("# Card\n\n"));
        assert.deepEqual(
          disappearedLines(before.join("\n"), after.join("\n")),
          before.filter((row) => !after.includes(row)),
        );
      },
    ),
    CHECKS,
  );
});

void test("мягкий разбор ответа: ограды markdown и текст вокруг JSON", () => {
  assert.deepEqual(parseJson('Вот:\n```json\n{"a":{"b":1}}\n```\nготово'), {
    a: { b: 1 },
  });
  assert.throws(() => parseJson("нет json"), /JSON/u);
});

void test("выжимка без body_hash — граница перехода, с несошедшимся — правка владельца", () => {
  const ours = summaryText({ type: "daily-summary" }, "# День\n");
  assert.equal(summaryEdited(ours), false);
  assert.equal(summaryEdited(ours.replace("# День", "# Правка")), true);
  assert.equal(
    summaryEdited('---\ndescription: "старая ночь"\n---\n# День\n'),
    false,
  );
  assert.equal(summaryEdited('---\ndescription: "битая\n---\n# День\n'), true);
});

void test(`месяц: полные недели и дни краёв, без повторов (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2000, max: 2099 }),
      fc.integer({ min: 1, max: 12 }),
      (year, month) => {
        const id = `${year}-${String(month).padStart(2, "0")}`;
        const children = periodChildIds("monthly", id);
        assert.ok(
          children
            .filter((child) => !child.includes("W"))
            .every((day) => day.startsWith(`${id}-`)),
        );
        assert.equal(new Set(children).size, children.length);
      },
    ),
    CHECKS,
  );
});

void test("месяц ждёт неготового ребёнка с транскриптом и собирается без транскрипта краевого дня (ДЕФ-15)", (t) => {
  const vault = mkdtempSync(join(tmpdir(), "iva-period-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const children = periodChildIds("monthly", "2026-08");
  const write = (dir: string, name: string) => {
    mkdirSync(join(vault, dir), { recursive: true });
    writeFileSync(join(vault, dir, `${name}.md`), "x");
  };
  for (const child of children.slice(1))
    write(child.includes("W") ? "weekly" : "summaries/daily", child);
  assert.ok(
    periodChildren(vault, "monthly", "2026-08"),
    "первый краевой день без транскрипта — «нет данных»",
  );
  write("daily", children[0]);
  assert.equal(periodChildren(vault, "monthly", "2026-08"), null);
});

void test("предел и размер части закреплены в одном модуле", () => {
  assert.deepEqual(NIGHT_CEILING, { calls: 40, inputTokens: 300_000 });
  assert.equal(PART_SIZE, 48_000);
});

void test("TS-граф имеет формат, который читает memory_search", (t) => {
  const vault = mkdtempSync(join(tmpdir(), "iva-graph-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  mkdirSync(join(vault, "cards"));
  writeFileSync(join(vault, "cards/a.md"), "# A\n\n[[cards/b]]\n[[missing]]\n");
  writeFileSync(join(vault, "cards/b.md"), "# B\n");
  const graph = buildVaultGraph(vault);
  assert.deepEqual(graph.nodes["cards/a"].outgoing, ["cards/b"]);
  assert.deepEqual(graph.nodes["cards/b"].incoming, ["cards/a"]);
  assert.deepEqual(graph.broken, [{ source: "cards/a", target: "missing" }]);
});

void test("resolveStopAt: будущий срок раннера принимается, прошлый и мусор — отказ", () => {
  assert.equal(resolveStopAt("2000", 1000), 2000);
  assert.ok(resolveStopAt(undefined, 1000) > 1000);
  assert.throws(() => resolveStopAt("999", 1000));
  assert.throws(() => resolveStopAt("later", 1000));
});
