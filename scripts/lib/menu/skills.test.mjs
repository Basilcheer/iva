import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import skills from "./skills.mjs";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "iva-menu-skills-"));
}

function writeSummary(root, value) {
  const summaryDir = join(root, ".eve");
  mkdirSync(summaryDir, { recursive: true });
  writeFileSync(join(summaryDir, "agent-summary.json"), value);
}

function makeCtx(root, lang = "en") {
  return {
    deps: { root },
    tr: (en, ru) => (lang === "ru" ? ru : en),
    btn: (text, callback_data) => ({ text, callback_data }),
    backRow: (sid) => [{ text: "back", callback_data: `iva_menu:${sid}:o` }],
  };
}

function skillList(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `skill-${index + 1}`,
    description: `description-${index + 1}`,
  }));
}

test("skills reports an unavailable summary for missing and corrupt files", () => {
  for (const fixture of ["missing", "corrupt"]) {
    const root = makeRoot();
    if (fixture === "corrupt") writeSummary(root, "{not-json");

    const view = skills.render({ page: 0 }, makeCtx(root));

    assert.match(view.text, /Skill list is unavailable/);
    assert.match(view.text, /agent-summary\.json not found/);
    assert.deepEqual(view.rows, [
      [{ text: "back", callback_data: "iva_menu:r:o" }],
    ]);
  }
});

test("skills distinguishes an empty registered list from an unavailable summary", () => {
  const root = makeRoot();
  writeSummary(root, JSON.stringify({ skills: [] }));

  const view = skills.render({ page: 0 }, makeCtx(root, "ru"));

  assert.equal(view.text, "🧩 Скиллы\n\nСкиллов не зарегистрировано.");
  assert.deepEqual(view.rows, [
    [{ text: "back", callback_data: "iva_menu:r:o" }],
  ]);
});

test("skills adds paging only after eight entries and keeps callback rows bounded", () => {
  const eightRoot = makeRoot();
  writeSummary(eightRoot, JSON.stringify({ skills: skillList(8) }));
  const eight = skills.render({ page: 0 }, makeCtx(eightRoot));

  assert.match(eight.text, /^🧩 Skills \(8\)/);
  assert.equal(eight.text.match(/^• /gm)?.length, 8);
  assert.deepEqual(eight.rows, [
    [{ text: "back", callback_data: "iva_menu:r:o" }],
  ]);

  const nineRoot = makeRoot();
  writeSummary(nineRoot, JSON.stringify({ skills: skillList(9) }));
  const first = skills.render({ page: 0 }, makeCtx(nineRoot));
  const second = skills.render({ page: 1 }, makeCtx(nineRoot));

  assert.equal(first.text.match(/^• /gm)?.length, 8);
  assert.equal(second.text.match(/^• /gm)?.length, 1);
  assert.match(second.text, /• skill-9 — description-9$/);
  assert.deepEqual(first.rows, [
    [
      { text: "‹", callback_data: "iva_menu:sk:pg:0" },
      { text: "1/2", callback_data: "iva_menu:sk:pg:0" },
      { text: "›", callback_data: "iva_menu:sk:pg:1" },
    ],
    [{ text: "back", callback_data: "iva_menu:r:o" }],
  ]);
  assert.deepEqual(second.rows, [
    [
      { text: "‹", callback_data: "iva_menu:sk:pg:0" },
      { text: "2/2", callback_data: "iva_menu:sk:pg:1" },
      { text: "›", callback_data: "iva_menu:sk:pg:1" },
    ],
    [{ text: "back", callback_data: "iva_menu:r:o" }],
  ]);
});

test("skills normalizes whitespace, truncates descriptions, and tolerates missing fields", () => {
  const root = makeRoot();
  const normalized = `alpha beta ${"x".repeat(80)}`;
  writeSummary(
    root,
    JSON.stringify({
      skills: [
        { name: "demo", description: `  alpha\n\t beta   ${"x".repeat(80)}  ` },
        {},
      ],
    }),
  );

  const view = skills.render({ page: 0 }, makeCtx(root));

  assert.match(view.text, new RegExp(`• demo — ${normalized.slice(0, 60)}\\n`));
  assert.match(view.text, /\n• \?$/);
  assert.ok(!view.text.includes(normalized.slice(0, 61)));
});

test("skills clamps the requested page and writes the effective page to state", () => {
  const root = makeRoot();
  writeSummary(root, JSON.stringify({ skills: skillList(9) }));

  const below = { page: -7 };
  const above = { page: 99 };
  const belowView = skills.render(below, makeCtx(root));
  const aboveView = skills.render(above, makeCtx(root));

  assert.equal(below.page, 0);
  assert.equal(above.page, 1);
  assert.match(belowView.text, /• skill-1 — description-1/);
  assert.match(aboveView.text, /• skill-9 — description-9$/);
  assert.equal(belowView.rows[0][1].text, "1/2");
  assert.equal(aboveView.rows[0][1].text, "2/2");
});
