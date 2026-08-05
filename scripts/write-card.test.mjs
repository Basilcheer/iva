// Тесты write_card: слияние вместо перезаписи, идентичность по H1 (легаси-слаги),
// алиасы типов, безопасный YAML, конфликт кандидатов.
// Запуск: node --test scripts/write-card.test.mjs  (TS импортируется напрямую — Node 24
// стрипает типы; отдельная сборка не нужна).

import "./lib/ts-esm-hooks.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-card-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";
mkdirSync(join(VAULT, "cards", "contacts"), { recursive: true });
mkdirSync(join(VAULT, "cards", "notes"), { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));

process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

// Модуль читает схему на импорте — env выставлен выше.
const writeCard = (await import(join(REPO, "agent", "tools", "write_card.ts"))).default;
const call = (args) => writeCard.execute(writeCard.inputSchema.parse(args));

const read = (rel) => readFileSync(join(VAULT, rel), "utf8");

// Реальная карточка: без title во frontmatter, свёрнутый скаляр description, латинский
// легаси-слаг при кириллическом H1, поля вне схемы тула (tier/relevance/phone/…).
const LEGACY = `---
type: contact
description: >-
  Ясмин — AI-контент криейтор, фрилансер. Связалась через Telegram с предложением услуг.
tags: [contact, freelancer]
status: active
created: 2026-06-29
source: daily/2026-06-29.md
relevance: 0.55
tier: cold
domain: work
last_accessed: 2026-06-27
access_count: 1
phone: "+998 90 000 00 00"
---

# Ясмин (AI Content Creator)

Связалась через личный Telegram Шимы 29.06.2026 с холодным предложением услуг.

## Портфолио
https://drive.google.com/drive/folders/abc
`;

test("повторный write_card сливает карточку: поля вне схемы, created и старый body живы", async () => {
  writeFileSync(join(VAULT, "cards/contacts/yasmin.md"), LEGACY, "utf8");

  const res = await call({
    type: "contact",
    title: "Ясмин",
    description: "AI-контент криейтор, прислала новую смету",
    tags: ["contact", "ai-content"],
    body: "Прислала смету на видеоролик: 400 USD за 30 секунд.",
  });

  assert.equal(res.ok, true);
  // Найден легаси-файл, а не создан дубль «ясмин.md».
  assert.equal(res.file, "cards/contacts/yasmin.md");
  assert.equal(res.matchedBy, "title");
  assert.equal(res.action, "merged");

  const out = read("cards/contacts/yasmin.md");
  for (const kept of [
    "relevance: 0.55",
    "tier: cold",
    "last_accessed: 2026-06-27",
    "access_count: 1",
    "created: 2026-06-29",
    "source: daily/2026-06-29.md",
  ]) {
    assert.ok(out.includes(kept), `потеряно поле: ${kept}`);
  }
  assert.ok(out.includes('phone: "+998 90 000 00 00"'), "потерян phone");
  assert.ok(out.includes("Портфолио"), "потерян старый body");
  assert.ok(out.includes("холодным предложением услуг"), "потерян старый текст");
  assert.ok(out.includes("400 USD"), "новый текст не дописан");
  // description обновлён и не задвоен (исторический баг свёрнутых скаляров).
  assert.equal(out.match(/^description:/gm).length, 1);
  assert.ok(!out.includes("Связалась через Telegram с предложением услуг."), "старый description остался");
  // Теги слиты, а не заменены.
  const tags = /^tags: \[(.*)\]$/m.exec(out)[1];
  assert.ok(tags.includes("freelancer") && tags.includes("ai-content"));
  // Один frontmatter, один H1.
  assert.equal(out.match(/^---$/gm).length, 2);
  assert.equal(out.match(/^# /gm).length, 1);
});

test("тот же body второй раз не дублируется", async () => {
  const args = {
    type: "note",
    title: "Заметка про кэш",
    description: "Кэш инвалидируется по тегам",
    tags: ["note", "cache"],
    body: "Инвалидация кэша идёт по тегам, TTL 300 секунд.",
  };
  const first = await call(args);
  assert.equal(first.action, "created");
  const second = await call(args);
  assert.equal(second.action, "updated");
  const out = read(second.file);
  assert.equal(out.match(/TTL 300 секунд/g).length, 1);
  assert.ok(!out.includes("## Обновление"));
});

test("алиас типа person → contact применяется до валидации", async () => {
  const res = await call({
    type: "person",
    title: "Тестовый Контакт",
    description: "проверка алиаса",
    tags: ["contact"],
    body: "Алиас person должен маппиться в contact.",
  });
  assert.equal(res.ok, true);
  assert.equal(res.type, "contact");
  assert.ok(res.file.startsWith("cards/contacts/"));
});

test("алиас в тип вне тула (daily) по-прежнему отклоняется", () => {
  assert.throws(() => writeCard.inputSchema.parse({
    type: "daily",
    title: "x",
    description: "x",
    tags: ["x"],
    body: "x",
  }));
});

test("description длиннее 500 символов отклоняется с просьбой сократить", () => {
  assert.throws(
    () =>
      writeCard.inputSchema.parse({
        type: "note",
        title: "Слишком длинное описание",
        description: "x".repeat(501),
        tags: ["note"],
        body: "тело",
      }),
    /максимум 500 символов; сократи/,
  );
});

test("history_entry принимает только одну строку", () => {
  assert.throws(
    () =>
      writeCard.inputSchema.parse({
        operation: "SUPERSEDE",
        type: "note",
        title: "Многострочная история",
        description: "проверка структурной безопасности history entry",
        tags: ["note"],
        body: "Новая истина",
        history_entry: "Старая истина\n\n## Log\n- injected",
      }),
    /одной строкой/,
  );
});

test("tags и domain квотируются, если содержат YAML-спецсимволы", async () => {
  const res = await call({
    type: "note",
    title: "YAML квотинг",
    description: "проверка квотинга",
    tags: ["a: b", "plain"],
    domain: "work: personal",
    body: "тело",
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const out = read(res.file);
  // Пробелы в теге схлопываются в дефис, но двоеточие остаётся — элемент обязан быть в кавычках.
  assert.ok(out.includes('tags: ["a:-b", plain]'), out);
  assert.ok(out.includes('domain: "work: personal"'), out);
});

test("несколько кандидатов по заголовку → отказ без записи", async () => {
  const dir = join(VAULT, "cards", "notes");
  const card = (h1) => `---\ntype: note\nstatus: active\n---\n\n# ${h1}\n\nтекст\n`;
  writeFileSync(join(dir, "dup-a.md"), card("Дубль Тема"), "utf8");
  writeFileSync(join(dir, "dup-b.md"), card("Дубль Тема (второй)"), "utf8");

  const res = await call({
    type: "note",
    title: "Дубль Тема",
    description: "конфликт",
    tags: ["note"],
    body: "новый текст",
  });
  assert.equal(res.ok, false);
  assert.equal(res.candidates.length, 2);
  assert.ok(!readFileSync(join(dir, "dup-a.md"), "utf8").includes("новый текст"));
  assert.ok(!readFileSync(join(dir, "dup-b.md"), "utf8").includes("новый текст"));
});

test("related дописываются в существующую секцию без дублей", async () => {
  const base = {
    type: "note",
    title: "Связи",
    description: "проверка related",
    tags: ["note"],
    body: "первичный текст",
    related: ["majento"],
  };
  const first = await call(base);
  await call({ ...base, body: "второй текст", related: ["majento", "aimasters"] });
  const out = read(first.file);
  assert.equal(out.match(/^## Related$/gm).length, 1);
  assert.equal(out.match(/\[\[majento\]\]/g).length, 1);
  assert.ok(out.includes("[[aimasters]]"));
});

test("явные UPDATE складываются в единственный Log без датированных H2", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Единый журнал",
    description: "проверка единственного журнала",
    tags: ["note", "log"],
    body: "Текущая выжимка.",
    related: ["cards/notes/hub"],
  };
  const created = await call(base);
  assert.equal(created.ok, true);
  await call({
    ...base,
    operation: "UPDATE",
    body: "Добавлен первый непротиворечивый факт.",
  });
  await call({
    ...base,
    operation: "UPDATE",
    body: "Добавлен второй непротиворечивый факт.",
  });
  const out = read(created.file);
  assert.equal(out.match(/^## Log$/gm).length, 1);
  assert.equal(out.match(/^## (?:Обновление|Update) /gm), null);
  assert.match(out, /^- \d{4}-\d{2}-\d{2}: Добавлен первый/m);
  assert.match(out, /^- \d{4}-\d{2}-\d{2}: Добавлен второй/m);

  const before = out;
  const repeated = await call({
    ...base,
    operation: "UPDATE",
    body: "Добавлен второй непротиворечивый факт.",
  });
  assert.equal(repeated.action, "updated");
  assert.equal(read(created.file), before, "повтор факта должен быть byte-stable");
});

test("ADD не перезаписывает, UPDATE не создаёт, NOOP не пишет и требует карточку", async () => {
  const base = {
    type: "note",
    title: "Границы операции",
    description: "проверка контрактов операций",
    tags: ["note", "operation"],
    body: "Исходное содержимое.",
  };
  const created = await call({ ...base, operation: "ADD" });
  const before = read(created.file);
  const duplicate = await call({ ...base, operation: "ADD", body: "Нельзя записать." });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /ADD отказан/);
  assert.equal(read(created.file), before);

  const notesDir = join(VAULT, "cards", "notes");
  const countBeforeMissingUpdate = readdirSync(notesDir).length;
  const missing = await call({
    ...base,
    operation: "UPDATE",
    title: "Отсутствующая карточка для UPDATE",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /UPDATE требует существующую/);
  assert.equal(
    readdirSync(notesDir).length,
    countBeforeMissingUpdate,
    "UPDATE missing must not create a second card",
  );

  const projectDir = join(VAULT, "cards", "projects");
  assert.equal(existsSync(projectDir), false);
  const noop = await call({
    ...base,
    operation: "NOOP",
    type: "project",
    title: "NOOP без каталога",
    status: "active",
  });
  assert.equal(noop.ok, false);
  assert.match(noop.error, /NOOP требует существующую/);
  assert.equal(existsSync(projectDir), false, "NOOP не должен создавать даже каталог");

  const existingNoop = await call({ ...base, operation: "NOOP" });
  assert.equal(existingNoop.action, "noop");
  assert.equal(read(created.file), before, "NOOP существующей карточки не меняет файл");
});

test("body с Related отклоняется без записи", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Related только параметром",
    description: "проверка запрета Related в body",
    tags: ["note", "related"],
    body: "Исходная истина.",
  };
  const created = await call(base);
  const before = read(created.file);
  const rejected = await call({
    ...base,
    operation: "UPDATE",
    body: "Новый факт.\n\n## Related\n- [[wrong-place]]",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /pass links through related/);
  assert.equal(read(created.file), before);
});

test("UPDATE отклоняет H1/H2 и существующие legacy dated-секции без записи", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Fail closed update",
    description: "проверка структурных границ update",
    tags: ["note", "update"],
    body: "Текущая истина.",
  };
  const created = await call(base);
  const before = read(created.file);
  const heading = await call({
    ...base,
    operation: "UPDATE",
    body: "Новый факт.\n\n## Next steps\nнеструктурированный хвост",
  });
  assert.equal(heading.ok, false);
  assert.match(heading.error, /without H1\/H2 headings/);
  assert.equal(read(created.file), before);

  const legacy = `${before.trimEnd()}\n\n## Обновление 2026-08-01\nСтарый факт.\n`;
  writeFileSync(join(VAULT, created.file), legacy);
  const dated = await call({ ...base, operation: "UPDATE", body: "Ещё один факт." });
  assert.equal(dated.ok, false);
  assert.match(dated.error, /run semantic cleanup before UPDATE/);
  assert.equal(read(created.file), legacy);
});

test("fenced структурные заголовки остаются кодом", async () => {
  const fenced = [
    "Пример формата:",
    "```markdown",
    "## Related",
    "## Log",
    "## Update 2026-08-05",
    "```",
  ].join("\n");
  const created = await call({
    operation: "ADD",
    type: "note",
    title: "Пример fenced headings",
    description: "структурные заголовки внутри code fence",
    tags: ["note", "fence"],
    body: fenced,
    related: ["cards/notes/hub"],
  });
  assert.equal(created.ok, true);
  const out = read(created.file);
  assert.ok(out.includes(fenced), "code example must remain byte-identical");
  assert.equal(out.match(/^## Related$/gm).length, 2, "one fenced example plus one real section");

  await call({
    operation: "UPDATE",
    type: "note",
    title: "Пример fenced headings",
    description: "структурные заголовки внутри code fence",
    tags: ["note", "fence"],
    body: "Совместимый новый факт.",
    related: ["cards/notes/hub#part|Hub"],
  });
  const updated = read(created.file);
  assert.ok(updated.includes(fenced));
  assert.equal(updated.match(/^## Log$/gm).length, 2, "one fenced example plus one real section");
  assert.match(updated, /^- \d{4}-\d{2}-\d{2}: Совместимый новый факт\.$/m);
});

test("Related дедуплицирует target по alias/anchor и не считает ссылку в prose", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Нормализация Related",
    description: "проверка идентичности ссылок",
    tags: ["note", "related"],
    body: "В тексте уже упомянут [[cards/notes/hub]], но это не секция связей.",
    related: ["cards/notes/hub#top|Hub"],
  };
  const created = await call(base);
  await call({
    ...base,
    operation: "UPDATE",
    body: "Ещё один факт.",
    related: ["cards/notes/hub#other|Other", "cards/notes/sibling"],
  });
  const out = read(created.file);
  assert.equal(out.match(/^## Related$/gm).length, 1);
  assert.equal(out.match(/\[\[cards\/notes\/hub#/g).length, 1);
  assert.equal(out.match(/\[\[cards\/notes\/hub\]\]/g).length, 1, "prose link remains separate");
  assert.equal(out.match(/\[\[cards\/notes\/sibling\]\]/g).length, 1);
});

test("SUPERSEDE требует history_entry, заменяет truth и сохраняет History", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Смена владельца",
    description: "текущий владелец Alice",
    tags: ["note", "owner"],
    body:
      "Current owner: Alice\n\n## Evidence\n\n```text\nowner: Alice\n```\n\n" +
      "## Log\n- 2026-07-01: Ownership confirmed\n\n" +
      "## History\n\n- 2025: Initial owner Carol\n  Continued detail\n",
    related: ["cards/contacts/alice"],
  };
  const created = await call(base);
  const before = read(created.file);
  const rejected = await call({
    ...base,
    operation: "SUPERSEDE",
    description: "текущий владелец Bob",
    body: "Current owner: Bob",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /требует history_entry/);
  assert.equal(read(created.file), before);

  const fencedLegacy = await call({
    ...base,
    operation: undefined,
    replace_body: true,
    body: "Current owner: Bob\n\n```markdown\n## History\n- example only\n```",
  });
  assert.equal(fencedLegacy.ok, false);
  assert.match(fencedLegacy.error, /legacy replace_body должен содержать ## History/);
  assert.equal(read(created.file), before);

  const replaced = await call({
    ...base,
    operation: "SUPERSEDE",
    description: "текущий владелец Bob",
    body: "Current owner: Bob",
    history_entry: "2026-01→08: Current owner Alice",
    related: ["cards/contacts/bob"],
  });
  assert.equal(replaced.action, "replaced");
  const out = read(created.file);
  const current = out.split("## History")[0];
  assert.match(current, /Current owner: Bob/);
  assert.doesNotMatch(current, /Current owner: Alice/);
  assert.equal(out.match(/^## History$/gm).length, 1);
  assert.equal(out.match(/^## Log$/gm).length, 1);
  assert.equal(out.match(/^## Related$/gm).length, 1);
  assert.match(out, /Initial owner Carol/);
  assert.ok(
    out.includes("## History\n\n- 2025: Initial owner Carol\n  Continued detail\n"),
    "existing History must remain byte-for-byte before the appended entry",
  );
  assert.match(out, /Current owner Alice/);
  assert.match(out, /Ownership confirmed/);
  assert.match(out, /## Evidence\n\n```text\nowner: Alice\n```/);
  assert.match(out, /\[\[cards\/contacts\/alice\]\]/);
  assert.match(out, /\[\[cards\/contacts\/bob\]\]/);
});

test("SUPERSEDE заменяет явно названную custom-секцию и сохраняет остальные", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Явная замена секции",
    description: "проверка preserve replace semantics",
    tags: ["note", "supersede"],
    body: "Truth v1\n\n## Evidence\nold evidence\n\n## Notes\nkeep me",
  };
  const created = await call(base);
  const result = await call({
    ...base,
    operation: "SUPERSEDE",
    body: "Truth v2\n\n## Evidence\nnew evidence",
    history_entry: "Truth v1",
  });
  assert.equal(result.action, "replaced");
  const out = read(created.file);
  assert.match(out, /Truth v2/);
  assert.doesNotMatch(out, /old evidence/);
  assert.match(out, /## Evidence\nnew evidence/);
  assert.match(out, /## Notes\nkeep me/);
});

test("legacy replace_body требует непустой History prefix и добавляет только suffix", async () => {
  const base = {
    operation: "ADD",
    type: "note",
    title: "Legacy History prefix",
    description: "проверка безопасной совместимости replace body",
    tags: ["note", "legacy"],
    body: "Truth v1\n\n## History\n\n- 2025-01-01: Truth v0",
  };
  const created = await call(base);
  const before = read(created.file);

  for (const body of [
    "Truth v2\n\n## History\n",
    "Truth v2\n\n## History\n\n- 2025-01-01: Different history\n- 2026-08-05: Truth v1",
    "Truth v2\n\n## History\n\n- 2025-01-01: Truth v0",
  ]) {
    const rejected = await call({ ...base, operation: undefined, replace_body: true, body });
    assert.equal(rejected.ok, false);
    assert.equal(read(created.file), before);
  }

  const replaced = await call({
    ...base,
    operation: undefined,
    replace_body: true,
    body:
      "Truth v2\n\n## History\n\n- 2025-01-01: Truth v0\n- 2026-08-05: Truth v1",
  });
  assert.equal(replaced.action, "replaced");
  const out = read(created.file);
  assert.equal(out.match(/2025-01-01: Truth v0/g).length, 1);
  assert.equal(out.match(/2026-08-05: Truth v1/g).length, 1);
  assert.match(out, /Truth v2/);
});

// ─── лок и атомарная запись ────────────────────────────────────────────────
const { acquireLock, atomicWrite } = await import(join(REPO, "agent", "lib", "card-store.ts"));

test("лок сериализует запись: второй захват ждёт и падает по таймауту", () => {
  const file = join(VAULT, "cards", "notes", "lock-probe.md");
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file, 100), /занята другим процессом/);
  release();
  acquireLock(file, 100)(); // после освобождения — снова доступно
});

test("atomicWrite не оставляет временных файлов и пишет целиком", () => {
  const dir = join(VAULT, "cards", "notes");
  const file = join(dir, "atomic-probe.md");
  atomicWrite(file, "содержимое\n");
  assert.equal(readFileSync(file, "utf8"), "содержимое\n");
  assert.equal(readdirSync(dir).filter((n) => n.includes(".tmp-")).length, 0);
});
