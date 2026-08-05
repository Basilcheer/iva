import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTaskCount } from "./crons.mjs";

test("openTaskCount reports only open tasks for array and wrapped storage shapes", () => {
  for (const value of [
    [
      { text: "open" },
      { text: "done", done: true },
      { text: "explicit open", done: false },
    ],
    { tasks: [{ text: "open" }, { text: "done", done: true }] },
  ]) {
    const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-task-count-"));
    try {
      writeFileSync(join(dataDir, "tasks.json"), JSON.stringify(value));
      assert.equal(openTaskCount(dataDir), value.tasks ? 1 : 2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
