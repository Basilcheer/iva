import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolContext } from "eve/tools";
import "../lib/ts-esm-hooks.ts";

const writeCard = (await import("../../agent/tools/write_card.ts")).default;
const writeFile = (await import("../../agent/tools/write_file.ts")).default;
const { writeCore } = await import("../../agent/lib/core-write.ts");
const context = {} as ToolContext;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(t: TestContext): { vault: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "iva-memory-writers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  mkdirSync(vault);
  writeFileSync(
    join(vault, "CORE.md"),
    "# CORE\n\n## Пользователь\n\n## Предпочтения\n\n## Активные цели\n",
  );
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "memory-writer@example.invalid");
  git(vault, "config", "user.name", "Memory Writer Test");
  git(vault, "add", ".");
  git(vault, "commit", "-qm", "initial");
  process.env.ASSISTANT_VAULT_DIR = vault;
  process.env.ASSISTANT_TIMEZONE = "UTC";
  return { vault, outside: join(root, "outside.md") };
}

void test("write_card fact сохраняет чужие поля и дедуплицирует хвост источника", async (t) => {
  const fx = fixture(t);
  const file = join(fx.vault, "cards/projects/аврора.md");
  mkdirSync(join(fx.vault, "cards/projects"), { recursive: true });
  writeFileSync(
    file,
    [
      "---",
      'type: "project"',
      'description: "Старое"',
      'x_owner: "keep"',
      "---",
      "# Аврора",
      "",
      "Правда",
      "",
      "## Log",
      "",
      "## Related",
      "",
      "## History",
      "",
    ].join("\n"),
  );
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "card");
  const input = {
    operation: "fact" as const,
    type: "project" as const,
    title: "Аврора",
    text: "Срок в пятницу",
    source: "[[daily/2026-09-27]] 10:00",
    tags: [],
    aliases: [],
  };
  const first = await writeCard.execute(input, context);
  assert.equal((first as { ok?: boolean }).ok, true, JSON.stringify(first));
  const once = readFileSync(file, "utf8");
  assert.match(once, /x_owner: "keep"/u);
  assert.match(
    once,
    /- \d{4}-\d{2}-\d{2}: Срок в пятницу · \[\[daily\/2026-09-27\]\] 10:00/u,
  );
  const second = await writeCard.execute(input, context);
  assert.equal((second as { ok?: boolean }).ok, true, JSON.stringify(second));
  assert.equal(readFileSync(file, "utf8"), once);
});

void test("write_card truth архивирует вытеснённую правду, merge требует подтверждение", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/notes");
  mkdirSync(dir, { recursive: true });
  const card = (name: string, truth: string) =>
    [
      "---",
      'type: "note"',
      `description: "${name}"`,
      'custom: "alive"',
      "---",
      `# ${name}`,
      "",
      truth,
      "",
      "## Log",
      "",
      "## Related",
      "",
      "## History",
      "",
    ].join("\n");
  writeFileSync(join(dir, "главная.md"), card("Главная", "Старая правда"));
  writeFileSync(join(dir, "дубль.md"), card("Дубль", "Другая правда"));
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "cards");

  const truth = await writeCard.execute(
    {
      operation: "truth",
      type: "note",
      title: "Главная",
      text: "Новая правда",
      reason: "владелец уточнил",
      source: "[[daily/2026-09-27]]",
    },
    context,
  );
  assert.equal((truth as { ok?: boolean }).ok, true, JSON.stringify(truth));
  const changed = readFileSync(join(dir, "главная.md"), "utf8");
  assert.match(changed, /Новая правда/u);
  assert.match(changed, /Старая правда \(владелец уточнил/u);
  assert.match(changed, /custom: "alive"/u);

  const refused = await writeCard.execute(
    {
      operation: "merge",
      target: "Главная",
      duplicate: "Дубль",
      confirmed_by_owner: false,
    } as never,
    context,
  );
  assert.equal((refused as { ok?: boolean }).ok, false);
  assert.match(
    (refused as { error?: string }).error ?? "",
    /confirmed_by_owner/u,
  );
  const merged = await writeCard.execute(
    {
      operation: "merge",
      target: "Главная",
      duplicate: "Дубль",
      confirmed_by_owner: true,
    },
    context,
  );
  assert.equal((merged as { ok?: boolean }).ok, true, JSON.stringify(merged));
  assert.match(
    readFileSync(join(dir, "дубль.md"), "utf8"),
    /status: "superseded"/u,
  );
});

void test("write_file пишет снаружи и в library/, отказывает памяти vault и держит CORE cap", async (t) => {
  const fx = fixture(t);
  const external = await writeFile.execute(
    { path: fx.outside, content: "ok\n" },
    context,
  );
  assert.equal(
    (external as { ok?: boolean }).ok,
    true,
    JSON.stringify(external),
  );
  assert.equal(readFileSync(fx.outside, "utf8"), "ok\n");

  for (const path of [
    "daily/2026-09-27.md",
    "summaries/daily/2026-09-27.md",
    "weekly/2026-W39.md",
    "cards/notes/new.md",
  ]) {
    const refused = await writeFile.execute(
      { path: join(fx.vault, path), content: "raw" },
      context,
    );
    assert.equal((refused as { ok?: boolean }).ok, false, path);
    assert.equal(existsSync(join(fx.vault, path)), false, path);
  }
  const library = join(fx.vault, "library/book/01.md");
  const imported = await writeFile.execute(
    { path: library, content: "# Глава\n" },
    context,
  );
  assert.equal(
    (imported as { ok?: boolean }).ok,
    true,
    JSON.stringify(imported),
  );
  assert.equal(readFileSync(library, "utf8"), "# Глава\n");
  assert.equal(
    git(fx.vault, "log", "-1", "--format=%s"),
    "file library/book/01.md: write",
  );
  const oversized = await writeFile.execute(
    { path: join(fx.vault, "CORE.md"), content: "x".repeat(10_000) },
    context,
  );
  assert.equal((oversized as { ok?: boolean }).ok, false);
  assert.match(String((oversized as { error?: string }).error), /длиннее/u);
});

void test("ночь может только сокращать уже раздутый CORE, дневной шов отказывает", async (t) => {
  const fx = fixture(t);
  const file = join(fx.vault, "CORE.md");
  const oversized = `# CORE\n\n## Пользователь\n\n- ${"д".repeat(9_000)}\n`;
  writeFileSync(file, oversized);
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "oversized core");
  const shorter = oversized.slice(0, -100);
  const day = await writeCore({
    vault: fx.vault,
    next: shorter,
    reason: "day",
    date: "2026-09-27",
    mode: "day",
  });
  assert.equal(day.ok, false);
  const night = await writeCore({
    vault: fx.vault,
    next: shorter,
    reason: "free space",
    date: "2026-09-27",
    mode: "night",
  });
  assert.equal(night.ok, true, night.error);
  const longer = await writeCore({
    vault: fx.vault,
    next: `${shorter}x`,
    reason: "grow",
    date: "2026-09-27",
    mode: "night",
  });
  assert.equal(longer.ok, false);
});

void test("write_card без полей операции отвечает текстом и ничего не пишет", async (t) => {
  const fx = fixture(t);
  const before = git(fx.vault, "rev-parse", "HEAD");
  const result = (await writeCard.execute(
    { operation: "fact", type: "note", text: "факт без имени" },
    context,
  )) as { ok?: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /^write_card fact: .*title/u);
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), before);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});

void test("write_card не затирает нечитаемый файл на месте новой Card (ДЕФ-4 днём)", async (t) => {
  const fx = fixture(t);
  const file = join(fx.vault, "cards/contacts/борис.md");
  mkdirSync(join(fx.vault, "cards/contacts"), { recursive: true });
  const broken =
    '---\ndescription: "битая кавычка\n---\n# Борис\n\nТекст владельца\n';
  writeFileSync(file, broken);
  const result = await writeCard.execute(
    {
      operation: "fact",
      type: "contact",
      title: "Борис",
      text: "Новый факт",
      tags: [],
      aliases: [],
    },
    context,
  );
  assert.equal((result as { ok?: boolean }).ok, false);
  assert.equal(readFileSync(file, "utf8"), broken);
});

void test("отметка ночи в сыром дне видна старому isDayDone: откат не переразбирает день", () => {
  // Литералы старой ночи (b2cabffb scripts/lib/rollup-days.ts): отметка конца в служебном хвосте.
  const DONE = /^<!-- processed: .*-->$/u;
  const SERVICE =
    /^(?:|<!-- processed[:-].*-->|---|(?:processed|cards|summary): .*)$/u;
  const oldIsDayDone = (raw: string) => {
    const lines = raw.split(/\r?\n/u).map((line) => line.trimEnd());
    let start = lines.length;
    while (start > 0 && SERVICE.test(lines[start - 1])) start--;
    return lines.slice(start).some((line) => DONE.test(line));
  };
  const raw = "## 10:00 [text]\nФакт\n";
  const marked = `${raw}\n<!-- processed: memory-night 2026-09-26 -->\n`;
  assert.equal(oldIsDayDone(raw), false);
  assert.equal(oldIsDayDone(marked), true);
});

void test("поля ночи truth_date и truth_pending живы после старого write_card (откат на прошлую версию)", async () => {
  // mergeCard — движок write_card прошлой версии: откат пишет Card им.
  const { mergeCard } = await import("../../agent/lib/card-store.ts");
  const existing = [
    "---",
    'type: "note"',
    'description: "Проект"',
    'truth_date: "2026-09-26"',
    'truth_pending: "2026-09-25"',
    "---",
    "# Аврора",
    "",
    "Правда",
    "",
    "## Log",
    "",
  ].join("\n");
  const { content } = mergeCard({
    operation: "UPDATE",
    title: "Аврора",
    fields: { description: "Проект" },
    body: "Новый факт",
    date: "2026-09-27",
    existing,
  });
  assert.match(content, /truth_date: "2026-09-26"/u);
  assert.match(content, /truth_pending: "2026-09-25"/u);
});

void test("незакрытый фенс: fact, truth и merge отказывают до записи, байты Card целы (#14)", async (t) => {
  const fx = fixture(t);
  const dir = join(fx.vault, "cards/notes");
  mkdirSync(dir, { recursive: true });
  const fenced = [
    "---",
    'type: "note"',
    "---",
    "# Фенс",
    "",
    "```",
    "## History",
    "код",
    "",
    "## Log",
    "",
    "## Related",
    "",
    "## History",
    "",
  ].join("\n");
  const clean = fenced
    .replace("```\n## History\nкод\n", "")
    .replace("# Фенс", "# Чистая");
  writeFileSync(join(dir, "фенс.md"), fenced);
  writeFileSync(join(dir, "чистая.md"), clean);
  git(fx.vault, "add", ".");
  git(fx.vault, "commit", "-qm", "cards");
  const calls = [
    { operation: "fact", type: "note", title: "Фенс", text: "факт" },
    {
      operation: "truth",
      type: "note",
      title: "Фенс",
      text: "Правда",
      reason: "r",
    },
    {
      operation: "merge",
      target: "Фенс",
      duplicate: "Чистая",
      confirmed_by_owner: true,
    },
    {
      operation: "merge",
      target: "Чистая",
      duplicate: "Фенс",
      confirmed_by_owner: true,
    },
  ];
  for (const input of calls) {
    const result = (await writeCard.execute(input as never, context)) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(result.error ?? "", /блок кода/u);
    assert.equal(readFileSync(join(dir, "фенс.md"), "utf8"), fenced);
    assert.equal(readFileSync(join(dir, "чистая.md"), "utf8"), clean);
  }
});

void test("CORE: замок дневных писателей держит и CORE, файл пишется раньше History, указатель в History не уходит (#1, #9, Н-4)", async (t) => {
  const fx = fixture(t);
  const { acquireLock } = await import("../../agent/lib/card-store.ts");
  const file = join(fx.vault, "CORE.md");
  const before = readFileSync(file, "utf8");
  mkdirSync(join(fx.vault, "cards"), { recursive: true });
  const release = await acquireLock(join(fx.vault, "cards", ".write_card"));
  const busy = await writeCore({
    vault: fx.vault,
    next: `${before}- занято\n`,
    reason: "day",
    date: "2026-09-27",
    mode: "day",
  }).catch((error: unknown) => ({ ok: false, error: String(error) }));
  release();
  assert.equal(busy.ok, false);
  assert.match(busy.error ?? "", /занята/u);
  assert.equal(readFileSync(file, "utf8"), before);

  const pointed = (day: string) =>
    `${before}\n## Указатели\n\n- Последний день: summaries/daily/${day}\n`;
  for (const day of ["2026-09-25", "2026-09-26"]) {
    const result = await writeCore({
      vault: fx.vault,
      next: pointed(day),
      reason: `night ${day}`,
      date: day,
      mode: "night",
    });
    assert.equal(result.ok, true, result.error);
  }
  assert.equal(existsSync(join(fx.vault, "CORE.history.md")), false);

  mkdirSync(join(fx.vault, "CORE.history.md"));
  const next = pointed("2026-09-26").replace(
    "## Пользователь\n",
    "## Пользователь\n\n- новое\n",
  );
  await writeCore({
    vault: fx.vault,
    next: next.replace("## Предпочтения\n", ""),
    reason: "night",
    date: "2026-09-27",
    mode: "night",
  }).catch(() => undefined);
  assert.match(readFileSync(file, "utf8"), /- новое/u);
});
