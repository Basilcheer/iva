/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Слот живых скиллов (agent/skills/custom.ts) и кривая шапка владельца. Тест лежит в
// agent/lib, а не рядом со слотом: eve считает артефактом каждый файл в слотах
// discovery (см. custom-slot.test.ts, trace-hook.test.ts).
//
// Шапка с c1 — metadata.hermes объектом — проходит через НАСТОЯЩИЙ defineSkill. Если eve
// начнёт проверять шапку в рантайме, первый тест покраснеет до выпуска; второй держит
// try/catch: одна запись, на которой defineSkill бросил, не уносит остальные.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "iva-custom-skip-"));
const DATA_DIR = join(root, "data");
process.env.ASSISTANT_DATA_DIR = DATA_DIR;
process.env.ASSISTANT_VAULT_DIR = join(root, "vault");
after(() => rmSync(root, { recursive: true, force: true }));

await import("../../scripts/lib/ts-esm-hooks.ts");
const slot = (await import(
  pathToFileURL(fileURLToPath(new URL("../skills/custom.ts", import.meta.url)))
    .href
)) as typeof import("../skills/custom.ts");

function skill(name: string, header: string): void {
  const dir = join(DATA_DIR, "custom", "agent", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${header}---\n# ${name}\nBody.\n`);
}

test("a skill with metadata.hermes as an object is live through the real defineSkill", async () => {
  skill(
    "zz-crooked",
    'description: Crooked header\nmetadata:\n  hermes:\n    emoji: "🧪"\n    requires: [git]\n',
  );
  skill("hello", "description: Says hello\n");
  const handler = slot.default.events["turn.started"];
  assert.ok(handler);
  const skills = await handler({}, {} as never);
  assert.ok(skills !== null);
  assert.deepEqual(Object.keys(skills).sort(), ["hello", "zz-crooked"]);
  assert.match(skills["zz-crooked"].markdown, /hermes/u);
});

test("a record defineSkill throws on is skipped by name, the rest stay", () => {
  const lines: string[] = [];
  const map = slot.liveSkillMap(
    {
      alpha: { description: "a", markdown: "# a" },
      "zz-crooked": { description: "c", markdown: "# c" },
      omega: { description: "o", markdown: "# o" },
    },
    (one) => {
      if (one.description === "c")
        throw new Error("metadata.hermes: expected string");
      return one;
    },
    (line) => lines.push(line),
  );
  assert.deepEqual(Object.keys(map), ["alpha", "omega"]);
  assert.deepEqual(lines, [
    "[skills] zz-crooked skipped: metadata.hermes: expected string",
  ]);
});
