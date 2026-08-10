/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Снапшот индексируемых полей memory_search: что именно уезжает в колонки FTS
// (title/meta/tags/body) и в отбраковку по status/confidence. Фиксирует контракт
// разбора frontmatter для поиска — карточки со свёрнутыми скалярами, блочными и
// flow-списками, CRLF, ключами в верхнем регистре, неизвестными полями, без
// frontmatter и с незакрытым frontmatter.
import "./lib/ts-esm-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VAULT = mkdtempSync(join(tmpdir(), "iva-memsearch-fm-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
mkdirSync(join(VAULT, "cards"), { recursive: true });
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const CARDS: Record<string, string> = {
  // Обычная карточка: скаляры и flow-список тегов.
  "plain.md": `---
type: contact
name: Иван Петров
company: Кинолаб
tags: [contact, video]
status: active
confidence: verified
source: telegram
---

# Иван Петров

Подрядчик по монтажу.
`,
  // Свёрнутый скаляр: смысл карточки живёт в description, в теле его нет.
  "folded.md": `---
name: Rushana
description: >-
  Продюсер студии,
  ведёт монтаж
status: Active
---
Тело.
`,
  // Литеральный блок плюс собственный title карточки.
  "literal.md": `---
title: План запуска
description: |-
  строка один
  строка два
---
Тело.
`,
  // Блочные списки: алиасы и теги.
  "block-list.md": `---
name: Проект Альфа
aliases:
  - alpha
  - альфа
tags:
  - project
  - archive
status: superseded
---
Тело.
`,
  // CRLF: карточка, приехавшая из Windows-редактора.
  "crlf.md": [
    "---",
    "name: CRLF Карточка",
    "status: active",
    "---",
    "Тело.",
    "",
  ].join("\r\n"),
  // Ключи в верхнем регистре: поиск не зависит от регистра ключа.
  "upper-keys.md": `---
Name: Верхний Регистр
Status: Superseded
Confidence: inferred
---
Тело.
`,
  // Неизвестные поля не протекают в индекс и не ломают известные.
  "unknown-fields.md": `---
tier: 1
last_accessed: 2026-01-01
last-accessed: 2026-01-02
name: Икс
---
Тело.
`,
  // Пустое значение известного поля.
  "empty-value.md": `---
name:
status: active
---
Тело.
`,
  // Кавычки: двоеточие внутри значения, одинарные кавычки, собака в хендле.
  "quoted.md": `---
name: "Пётр: главный"
role: 'CTO'
handle: "@petr"
---
Тело.
`,
  // Без frontmatter — весь файл идёт в тело.
  "no-frontmatter.md": `# Заметка

Без frontmatter.
`,
  // Незакрытый frontmatter — тоже целиком тело, полей нет.
  "unclosed.md": `---
name: Обрыв
status: active

Тело без закрытия.
`,
};

for (const [name, text] of Object.entries(CARDS))
  writeFileSync(join(VAULT, "cards", name), text, "utf8");

const EXPECTED = [
  {
    path: "cards/block-list.md",
    title: "block-list",
    meta: "Проект Альфа alpha альфа",
    body: "Тело.\n",
    tags: "project archive",
    status: "superseded",
    confidence: "",
    source: "",
  },
  {
    path: "cards/crlf.md",
    title: "crlf",
    meta: "CRLF Карточка",
    body: "Тело.\n",
    tags: "",
    status: "active",
    confidence: "",
    source: "",
  },
  {
    path: "cards/empty-value.md",
    title: "empty-value",
    meta: "",
    body: "Тело.\n",
    tags: "",
    status: "active",
    confidence: "",
    source: "",
  },
  {
    path: "cards/folded.md",
    title: "folded",
    meta: "Rushana Продюсер студии, ведёт монтаж",
    body: "Тело.\n",
    tags: "",
    status: "active",
    confidence: "",
    source: "",
  },
  {
    path: "cards/literal.md",
    title: "literal",
    meta: "строка один\nстрока два План запуска",
    body: "Тело.\n",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/no-frontmatter.md",
    title: "no-frontmatter",
    meta: "",
    body: "# Заметка\n\nБез frontmatter.\n",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/plain.md",
    title: "plain",
    meta: "Иван Петров Кинолаб",
    body: "\n# Иван Петров\n\nПодрядчик по монтажу.\n",
    tags: "contact video",
    status: "active",
    confidence: "VERIFIED",
    source: "telegram",
  },
  {
    path: "cards/quoted.md",
    title: "quoted",
    meta: "Пётр: главный CTO @petr",
    body: "Тело.\n",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/unclosed.md",
    title: "unclosed",
    meta: "",
    body: "---\nname: Обрыв\nstatus: active\n\nТело без закрытия.\n",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/unknown-fields.md",
    title: "unknown-fields",
    meta: "Икс",
    body: "Тело.\n",
    tags: "",
    status: "",
    confidence: "",
    source: "",
  },
  {
    path: "cards/upper-keys.md",
    title: "upper-keys",
    meta: "Верхний Регистр",
    body: "Тело.\n",
    tags: "",
    status: "superseded",
    confidence: "INFERRED",
    source: "",
  },
];

const { loadDocs, searchMemory } =
  await import("../agent/tools/memory_search.ts");

test("индексируемые поля карточек совпадают со снапшотом", async () => {
  const docs = (await loadDocs(["cards"])).sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  assert.deepEqual(docs, EXPECTED);
});

test("слово из свёрнутого description находится поиском", async () => {
  const { hits } = await searchMemory({ query: "продюсер", limit: 5 });
  assert.ok(
    hits.some((hit) => hit.file === "cards/folded.md"),
    `свёрнутый description обязан попадать в индекс: ${JSON.stringify(hits)}`,
  );
});
