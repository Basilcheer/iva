import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capDescription,
  cleanupVault,
  collapseRepeatedDescription,
} from "./vault-cleanup.ts";

void test("description collapse and cap preserve a single bounded value", () => {
  assert.equal(collapseRepeatedDescription("one two one two"), "one two");
  assert.equal(capDescription("word ".repeat(200)).length <= 501, true);
});

void test("streaming cleanup changes frontmatter and keeps body byte-identical", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-vault-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "card.md");
  const body = "# Card\n\nbody\n```\n---\n```\n";
  writeFileSync(
    file,
    `---\ntype: note\ndescription: "same same same same same same same same"\n---\n${body}`,
  );
  const dry = cleanupVault(root, false);
  assert.equal(dry.cleaned, 1);
  assert.match(
    readFileSync(file, "utf8"),
    /same same same same same same same same/u,
  );
  const applied = cleanupVault(root, true);
  assert.equal(applied.cleaned, 1);
  const changed = readFileSync(file, "utf8");
  assert.equal(changed.slice(changed.indexOf("# Card")), body);
  assert.match(changed, /description: "same"/u);
  assert.equal(cleanupVault(root, true).cleaned, 0);
});

void test("строка description больше порога чтения и больше куска — схлопывается, тело байт в байт", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-vault-cleanup-huge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "card.md");
  const unit = "Повторённое описание карточки после бага двойной записи";
  const body = "# Card\n\n```\n---\n```\nтело\n";
  const huge = Array.from({ length: 40_000 }, () => unit).join(" ");
  writeFileSync(
    file,
    `---\ntype: note\ndescription: >-\n  ${huge}\nstatus: active\n---\n${body}`,
  );
  assert.ok(huge.length > 2 * (1 << 20));
  assert.equal(cleanupVault(root, true).cleaned, 1);
  const changed = readFileSync(file, "utf8");
  assert.equal(
    changed,
    `---\ntype: note\ndescription: ${JSON.stringify(unit)}\nstatus: active\n---\n${body}`,
  );
});
