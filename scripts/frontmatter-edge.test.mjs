// Краевые случаи frontmatter.ts, найденные ревью: запятые в квотированных элементах
// flow-списка, YAML-неоднозначные скаляры, одиночный пробел как continuation, пустая
// строка внутри перезаписываемого folded-блока.
import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, writeFrontmatter } from "../agent/lib/frontmatter.ts";

test("flow-список: запятая внутри кавычек не рвёт элемент (round-trip)", () => {
  const { fields } = parseFrontmatter('---\ntags: [work, "a, b", plain]\n---\nbody');
  assert.deepEqual(fields.tags, ["work", "a, b", "plain"]);
});

test("YAML-неоднозначные скаляры квотируются (PyYAML не превратит их в bool/null)", () => {
  const text = writeFrontmatter({ status: "no", note: "null", ok: "обычное" }, []);
  assert.match(text, /status: "no"/);
  assert.match(text, /note: "null"/);
  assert.match(text, /ok: обычное/);
});

test("одиночный пробел — тоже continuation, а не новый ключ", () => {
  const { fields } = parseFrontmatter("---\ndescription: >-\n line one\n line two\nstatus: active\n---\nb");
  assert.equal(fields.description, "line one line two");
  assert.equal(fields.status, "active");
});

test("пустая строка внутри перезаписываемого folded-блока не воскрешает старый хвост", () => {
  const lines = ["type: contact", "description: >-", "  первый абзац", "", "  второй абзац", "status: active"];
  const out = writeFrontmatter({ description: "новое" }, lines);
  assert.doesNotMatch(out, /второй абзац/, "хвост старого блока не должен просочиться");
  assert.match(out, /description: новое/);
  assert.match(out, /status: active/);
});
