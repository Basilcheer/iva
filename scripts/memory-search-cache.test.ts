/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Кэш memory_search: второй вызов подряд не перечитывает карточки и не пересобирает
// FTS-индекс, но ЛЮБОЕ изменение vault'а — правка, добавление, удаление — кэш сбрасывает.
// Vault меняется и извне процесса (ночной Brain, git pull), поэтому проверяем именно
// внешние правки файлов, а не «мы сами записали и знаем».

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const VAULT = mkdtempSync(join(tmpdir(), "iva-memsearch-cache-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
mkdirSync(join(VAULT, "cards"), { recursive: true });
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const card = (name: string, body: string): string =>
  `---\ntype: contact\nname: ${name}\nstatus: active\n---\n\n# ${name}\n\n${body}\n`;

const cardPath = (slug: string): string => join(VAULT, "cards", `${slug}.md`);

writeFileSync(cardPath("ivan"), card("Иван Петров", "Подрядчик по монтажу."));
writeFileSync(cardPath("olga"), card("Ольга Смирнова", "Продюсер студии."));

const { searchMemory, cacheStats } =
  await import("../agent/tools/memory_search.ts");

test("первый вызов читает карточки и собирает индекс, второй — нет", async () => {
  const before = { ...cacheStats };
  const first = await searchMemory({ query: "монтаж" });
  assert.equal(cacheStats.fileReads - before.fileReads, 2);
  assert.equal(cacheStats.indexBuilds - before.indexBuilds, 1);
  assert.ok(first.hits.some((hit) => hit.file === "cards/ivan.md"));

  const after = { ...cacheStats };
  const second = await searchMemory({ query: "монтаж" });
  assert.equal(
    cacheStats.fileReads - after.fileReads,
    0,
    "чтений быть не должно",
  );
  assert.equal(
    cacheStats.indexBuilds - after.indexBuilds,
    0,
    "индекс не пересобирается",
  );
  assert.deepEqual(second.hits, first.hits);
});

test("правка карточки извне сбрасывает кэш: перечитана только она", async () => {
  await searchMemory({ query: "монтаж" }); // прогреть
  const before = { ...cacheStats };

  writeFileSync(
    cardPath("ivan"),
    card("Иван Петров", "Занялся цветокоррекцией."),
  );
  const res = await searchMemory({ query: "цветокоррекцией" });

  assert.equal(cacheStats.fileReads - before.fileReads, 1, "только изменённая");
  assert.equal(cacheStats.indexBuilds - before.indexBuilds, 1);
  assert.ok(res.hits.some((hit) => hit.file === "cards/ivan.md"));
  // Старое содержимое из индекса ушло — иначе поиск отдавал бы карточку по «монтаж».
  const stale = await searchMemory({ query: "монтаж" });
  assert.equal(
    stale.hits.some((hit) => hit.file === "cards/ivan.md"),
    false,
  );
});

test("новая карточка попадает в выдачу, удалённая — уходит", async () => {
  writeFileSync(cardPath("pavel"), card("Павел Кузнецов", "Оператор дрона."));
  const added = await searchMemory({ query: "дрон" });
  assert.ok(added.hits.some((hit) => hit.file === "cards/pavel.md"));

  rmSync(cardPath("pavel"));
  const removed = await searchMemory({ query: "дрон" });
  assert.equal(
    removed.hits.some((hit) => hit.file === "cards/pavel.md"),
    false,
  );

  // Удалённая карточка не остаётся висеть в кэше разобранных документов.
  const before = { ...cacheStats };
  await searchMemory({ query: "дрон" });
  assert.equal(cacheStats.fileReads - before.fileReads, 0);
});

test("правка того же размера в ту же миллисекунду тоже видна", async () => {
  // Снимок — mtime в наносекундах плюс размер: одинаковая длина и запись подряд не должны
  // выдавать старое содержимое. Ставим содержимое той же длины и пишем сразу же.
  await searchMemory({ query: "продюсер" });
  writeFileSync(cardPath("olga"), card("Ольга Смирнова", "Режиссёр студии."));
  const res = await searchMemory({ query: "режиссёр" });
  assert.ok(res.hits.some((hit) => hit.file === "cards/olga.md"));
});

// scope пишет модель, а её ведёт в том числе чужой текст: «..» в элементе scope увёл бы
// обход за пределы vault — к .env, ключам и чужим репозиториям, куски которых уехали бы
// обратно модели в snippet. Ничего вне корня читаться не должно ни при каком scope.
test("scope не выпускает поиск за пределы vault", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "iva-outside-"));
  process.on("exit", () =>
    rmSync(outsideDir, { recursive: true, force: true }),
  );
  const secret = "СЕКРЕТ-ЗА-ПРЕДЕЛАМИ-ВОЛЬТА";
  writeFileSync(join(outsideDir, "leak.md"), card("Ключи", `${secret} монтаж`));
  // Ещё и прямо рядом с vault: "../<сосед>" — самый вероятный вид обхода.
  const sibling = join(VAULT, "..", "iva-outside-sibling.md");
  writeFileSync(sibling, card("Соседний", `${secret} монтаж`));
  process.on("exit", () => rmSync(sibling, { force: true }));

  // Каталог, чьё имя НАЧИНАЕТСЯ с пути vault: `/tmp/X` и `/tmp/X-evil`. Проверка
  // префиксом без разделителя ("/tmp/X-evil".startsWith("/tmp/X") — правда) пустила бы
  // его внутрь, хотя это чужой каталог. Граница проходит по разделителю, и без этого
  // кейса разница между `root` и `root + sep` не видна ни одному другому scope.
  const evilTwin = `${VAULT}-evil`;
  mkdirSync(evilTwin, { recursive: true });
  process.on("exit", () => rmSync(evilTwin, { recursive: true, force: true }));
  writeFileSync(join(evilTwin, "twin.md"), card("Двойник", `${secret} монтаж`));

  const before = { ...cacheStats };
  for (const scope of [
    ["../.."],
    [".."],
    ["../" + basename(outsideDir)],
    [outsideDir],
    ["cards/../.."],
    ["/"],
    ["../" + basename(VAULT) + "-evil"],
    [evilTwin],
  ]) {
    const res = await searchMemory({ query: "монтаж секрет", scope });
    for (const hit of res.hits) {
      assert.ok(
        !hit.file.includes(".."),
        `путь вышел из vault: ${hit.file} (scope=${JSON.stringify(scope)})`,
      );
      assert.ok(
        !hit.snippet.includes(secret),
        `наружу утёк файл вне vault (scope=${JSON.stringify(scope)})`,
      );
    }
  }
  // Ни одного файла вне vault даже не прочитано.
  assert.equal(cacheStats.fileReads - before.fileReads, 0);

  // Нормальный scope продолжает работать — фикс не отрезал лишнего.
  writeFileSync(cardPath("scope-ok"), card("Внутри", "Стедикам на площадке."));
  const ok = await searchMemory({ query: "стедикам", scope: ["cards"] });
  assert.ok(
    ok.hits.some((hit) => hit.file === "cards/scope-ok.md"),
    JSON.stringify(ok.hits),
  );
  rmSync(cardPath("scope-ok"), { force: true });
});

// Свойство кэша: на ЛЮБОЙ последовательности правок vault прогретый модуль отвечает то
// же, что модуль с пустым кэшем на том же состоянии диска. Эталон — тот же код, но
// свежий экземпляр модуля (import с уникальным query-параметром даёт новую запись в
// реестре модулей, а значит пустые кэши), поэтому сверяется именно инвалидация, а не
// ранжирование. Seed фиксирован и печатается при провале — прогон воспроизводим.
const SEED = Number(process.env.IVA_TEST_SEED ?? 20260814);

// mulberry32: детерминированный PRNG в четыре строки, без зависимостей.
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("кэш не меняет выдачу: случайные правки vault, сверка со свежим модулем", async () => {
  const random = rng(SEED);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const words = [
    "монтаж",
    "смета",
    "договор",
    "эфир",
    "сценарий",
    "дрон",
    "продюсер",
    "площадка",
  ];
  const slugs = ["prop-a", "prop-b", "prop-c", "prop-d"];
  const text = (): string =>
    Array.from({ length: 4 }, () => pick(words)).join(" ");

  for (let step = 0; step < 60; step++) {
    const slug = pick(slugs);
    const file = cardPath(slug);
    const op = pick(["create", "modify", "delete", "same-size"]);
    if (op === "delete") rmSync(file, { force: true });
    else if (op === "same-size")
      writeFileSync(
        file,
        card("Карточка", text().padEnd(40, "х").slice(0, 40)),
      );
    else writeFileSync(file, card(`Карточка ${slug}`, text()));

    const query = `${pick(words)} ${pick(words)}`;
    const scope = random() < 0.25 ? ["cards"] : undefined;
    const warm = await searchMemory({ query, scope });
    // Свежий экземпляр модуля: тот же код, кэш пуст, диск тот же.
    const cold = (await import(
      `../agent/tools/memory_search.ts?step=${String(step)}`
    )) as typeof import("../agent/tools/memory_search.ts");
    const reference = await cold.searchMemory({ query, scope });
    assert.deepEqual(
      warm,
      reference,
      `шаг ${step} (op=${op}, query="${query}"): кэш разошёлся с чтением с нуля. seed=${SEED}`,
    );
  }
  for (const slug of slugs) rmSync(cardPath(slug), { force: true });
});

test("узкий scope не выбрасывает из кэша карточки, на которые не смотрел", async () => {
  mkdirSync(join(VAULT, "summaries"), { recursive: true });
  writeFileSync(
    join(VAULT, "summaries", "2026-08-01.md"),
    card("День", "Сводка дня про смету."),
  );
  await searchMemory({ query: "смета" }); // прогреть обе директории

  const narrow = { ...cacheStats };
  await searchMemory({ query: "смета", scope: ["summaries"] });
  // Индекс на другой набор файлов — своя пересборка; карточки при этом не перечитываются.
  assert.equal(cacheStats.fileReads - narrow.fileReads, 0);
  assert.equal(cacheStats.indexBuilds - narrow.indexBuilds, 1);

  const before = { ...cacheStats };
  await searchMemory({ query: "монтаж", scope: ["cards"] });
  assert.equal(cacheStats.fileReads - before.fileReads, 0);
  assert.equal(cacheStats.indexBuilds - before.indexBuilds, 1);

  // Повтор того же scope — ни чтений, ни пересборки.
  const repeat = { ...cacheStats };
  await searchMemory({ query: "монтаж", scope: ["cards"] });
  assert.equal(cacheStats.fileReads - repeat.fileReads, 0);
  assert.equal(cacheStats.indexBuilds - repeat.indexBuilds, 0);
});
