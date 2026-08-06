// Тесты контрактов файловых тулов: write_file не затирает существующие карточки,
// но продолжает писать CORE.md; путь из memory_search открывается read_file без ENOENT.

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-paths-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
mkdirSync(join(VAULT, "cards", "contacts"), { recursive: true });
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const CARD = join(VAULT, "cards", "contacts", "ivan.md");
writeFileSync(
  CARD,
  `---\ntype: contact\ndescription: Иван Петров, подрядчик по монтажу\ntags: [contact]\nstatus: active\n---\n\n# Иван Петров\n\nПодрядчик по видеомонтажу, работает через студию Кинолаб.\n`,
  "utf8",
);
writeFileSync(join(VAULT, "CORE.md"), "# CORE\n", "utf8");

const load = async (name) =>
  (await import(join(REPO, "agent", "tools", `${name}.ts`))).default;
const writeFile = await load("write_file");
const readFileTool = await load("read_file");
const memorySearch = await load("memory_search");

test("write_file отказывается перезаписать существующую карточку в cards/", async () => {
  const res = await writeFile.execute({ path: CARD, content: "затёрто" });
  assert.equal(res.ok, false);
  assert.match(res.error, /write_card/);
  assert.ok(
    readFileSync(CARD, "utf8").includes("Кинолаб"),
    "карточка всё-таки затёрта",
  );
});

test("write_file создаёт НОВЫЙ файл в cards/ как обычно", async () => {
  const fresh = join(VAULT, "cards", "contacts", "новый.md");
  const res = await writeFile.execute({ path: fresh, content: "# Новый\n" });
  assert.equal(res.ok, true);
  assert.equal(readFileSync(fresh, "utf8"), "# Новый\n");
});

test("write_file по-прежнему пишет vault/CORE.md (см. instructions/10-map.md)", async () => {
  const core = join(VAULT, "CORE.md");
  const res = await writeFile.execute({
    path: core,
    content: "# CORE\n- факт\n",
  });
  assert.equal(res.ok, true);
  assert.ok(readFileSync(core, "utf8").includes("факт"));
});

test("путь из memory_search открывается read_file без ENOENT", async () => {
  const found = await memorySearch.execute({
    query: "Иван Петров монтаж",
    limit: 5,
  });
  assert.ok(found.hits.length > 0, "memory_search ничего не нашёл");
  const hit = found.hits[0].file;
  // Контракт: hits[].file — vault-relative, read_file обязан его понять.
  assert.ok(
    !hit.startsWith("/"),
    `ожидался vault-относительный путь, получено ${hit}`,
  );
  const read = await readFileTool.execute({ path: hit });
  assert.ok(read.content.includes("Кинолаб"));
});

test("read_file принимает и абсолютный путь", async () => {
  const read = await readFileTool.execute({ path: CARD });
  assert.ok(read.content.includes("Иван Петров"));
});
