// Краевые случаи frontmatter.ts, найденные ревью: запятые в квотированных элементах
// flow-списка, YAML-неоднозначные скаляры, одиночный пробел как continuation, пустая
// строка внутри перезаписываемого folded-блока.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatter,
  writeFrontmatter,
} from "../agent/lib/frontmatter.ts";

test("flow-список: запятая внутри кавычек не рвёт элемент (полный round-trip)", () => {
  const { fields } = parseFrontmatter(
    '---\ntags: [work, "a, b", plain]\n---\nbody',
  );
  assert.deepEqual(fields.tags, ["work", "a, b", "plain"]);
  // parse → write → parse: значение обязано пережить полный цикл без искажений.
  const rewritten = writeFrontmatter(fields, []);
  const again = parseFrontmatter(`---\n${rewritten}\n---\nbody`);
  assert.deepEqual(again.fields.tags, ["work", "a, b", "plain"]);
});

test("YAML-неоднозначные скаляры квотируются (PyYAML не превратит их в bool/null)", () => {
  const text = writeFrontmatter(
    { status: "no", note: "null", ok: "обычное" },
    [],
  );
  assert.match(text, /status: "no"/);
  assert.match(text, /note: "null"/);
  assert.match(text, /ok: обычное/);
});

test("кавычки, переводы строк и разделитель frontmatter проходят безопасный round-trip", () => {
  const fields = {
    source: 'report "yes".pdf',
    page: "null",
    section: "Итоги\n---\nyes",
  };
  const text = writeFrontmatter(fields, []);
  assert.match(text, /source: "report \\"yes\\"\.pdf"/);
  assert.match(text, /page: "null"/);
  assert.equal(
    text.split("\n---\n").length,
    1,
    "escaped data must not create a frontmatter delimiter",
  );
  const parsed = parseFrontmatter(`---\n${text}\n---\nbody`);
  assert.deepEqual(parsed.fields, fields);
  assert.equal(parsed.body, "body");
});

test("одиночный пробел — тоже continuation, а не новый ключ", () => {
  const { fields } = parseFrontmatter(
    "---\ndescription: >-\n line one\n line two\nstatus: active\n---\nb",
  );
  assert.equal(fields.description, "line one line two");
  assert.equal(fields.status, "active");
});

test("пустая строка внутри перезаписываемого folded-блока не воскрешает старый хвост", () => {
  const lines = [
    "type: contact",
    "description: >-",
    "  первый абзац",
    "",
    "  второй абзац",
    "status: active",
  ];
  const out = writeFrontmatter({ description: "новое" }, lines);
  assert.doesNotMatch(
    out,
    /первый абзац/,
    "начало старого блока не должно остаться",
  );
  assert.doesNotMatch(
    out,
    /второй абзац/,
    "хвост старого блока не должен просочиться",
  );
  assert.match(out, /description: новое/);
  assert.match(out, /status: active/);
});

test("folded >- сохраняет абзацы через parse → write → parse", () => {
  const source =
    "---\ndescription: >-\n  Первый абзац\n\n  Второй абзац\n\n\n  Третий абзац\nstatus: active\n---\nbody";
  const first = parseFrontmatter(source);
  assert.equal(
    first.fields.description,
    "Первый абзац\nВторой абзац\n\nТретий абзац",
  );
  const written = writeFrontmatter(first.fields, first.lines);
  const second = parseFrontmatter(`---\n${written}\n---\nbody`);
  assert.equal(second.fields.description, first.fields.description);
  assert.equal(second.fields.status, "active");
});

test("literal |- сохраняет пустую строку между абзацами через round-trip", () => {
  const source =
    "---\nnote: |-\n  Строка один\n\n  Строка два\nkind: note\n---\nbody";
  const first = parseFrontmatter(source);
  assert.equal(first.fields.note, "Строка один\n\nСтрока два");
  const written = writeFrontmatter(first.fields, first.lines);
  const second = parseFrontmatter(`---\n${written}\n---\nbody`);
  assert.equal(second.fields.note, first.fields.note);
  assert.equal(second.fields.kind, "note");
});
