// Тесты контракта путей: путь из memory_search открывается read_file без ENOENT.

import "./lib/ts-esm-hooks.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

const load = async (name) => (await import(join(REPO, "agent", "tools", `${name}.ts`))).default;
const readFileTool = await load("read_file");
const memorySearch = await load("memory_search");

test("путь из memory_search открывается read_file без ENOENT", async () => {
  const found = await memorySearch.execute({ query: "Иван Петров монтаж", limit: 5 });
  assert.ok(found.hits.length > 0, "memory_search ничего не нашёл");
  const hit = found.hits[0].file;
  // Контракт: hits[].file — vault-relative, read_file обязан его понять.
  assert.ok(!hit.startsWith("/"), `ожидался vault-относительный путь, получено ${hit}`);
  const read = await readFileTool.execute({ path: hit });
  assert.ok(read.content.includes("Кинолаб"));
});

test("read_file принимает и абсолютный путь", async () => {
  const read = await readFileTool.execute({ path: CARD });
  assert.ok(read.content.includes("Иван Петров"));
});
