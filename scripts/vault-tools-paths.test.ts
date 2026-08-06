/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
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
import type { ToolContext } from "eve/tools";

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

const { default: writeFile } = await import("../agent/tools/write_file.ts");
const { default: readFileTool } = await import("../agent/tools/read_file.ts");
const { default: memorySearch } =
  await import("../agent/tools/memory_search.ts");

function testToolContext(toolName: string): ToolContext {
  const unavailable = (): never => {
    throw new Error("not used by this test");
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "vault-tools-paths",
    toolName,
    session: {
      id: "vault-tools-paths",
      auth: { current: null, initiator: null },
      turn: { id: "vault-tools-paths", sequence: 0 },
    },
    getSandbox: () => Promise.reject(new Error("not used by this test")),
    getSkill: unavailable,
    getToken: () => Promise.reject(new Error("not used by this test")),
    requireAuth: unavailable,
  };
}

test("write_file отказывается перезаписать существующую карточку в cards/", async () => {
  const res = await writeFile.execute(
    { path: CARD, content: "затёрто" },
    testToolContext("write_file"),
  );
  assert.equal(res.ok, false);
  if (typeof res.error !== "string") assert.fail("expected write_file error");
  assert.match(res.error, /write_card/);
  assert.ok(
    readFileSync(CARD, "utf8").includes("Кинолаб"),
    "карточка всё-таки затёрта",
  );
});

test("write_file создаёт НОВЫЙ файл в cards/ как обычно", async () => {
  const fresh = join(VAULT, "cards", "contacts", "новый.md");
  const res = await writeFile.execute(
    { path: fresh, content: "# Новый\n" },
    testToolContext("write_file"),
  );
  assert.equal(res.ok, true);
  assert.equal(readFileSync(fresh, "utf8"), "# Новый\n");
});

test("write_file по-прежнему пишет vault/CORE.md (см. instructions/10-map.md)", async () => {
  const core = join(VAULT, "CORE.md");
  const res = await writeFile.execute(
    {
      path: core,
      content: "# CORE\n- факт\n",
    },
    testToolContext("write_file"),
  );
  assert.equal(res.ok, true);
  assert.ok(readFileSync(core, "utf8").includes("факт"));
});

test("путь из memory_search открывается read_file без ENOENT", async () => {
  const found = await memorySearch.execute(
    {
      query: "Иван Петров монтаж",
      limit: 5,
    },
    testToolContext("memory_search"),
  );
  assert.ok(found.hits.length > 0, "memory_search ничего не нашёл");
  const hit = found.hits[0].file;
  // Контракт: hits[].file — vault-relative, read_file обязан его понять.
  assert.ok(
    !hit.startsWith("/"),
    `ожидался vault-относительный путь, получено ${hit}`,
  );
  const read = await readFileTool.execute(
    { path: hit },
    testToolContext("read_file"),
  );
  assert.ok(read.content.includes("Кинолаб"));
});

test("read_file принимает и абсолютный путь", async () => {
  const read = await readFileTool.execute(
    { path: CARD },
    testToolContext("read_file"),
  );
  assert.ok(read.content.includes("Иван Петров"));
});
