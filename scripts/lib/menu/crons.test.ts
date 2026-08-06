/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTaskCount } from "./crons.ts";

test("openTaskCount reports only open tasks for array and wrapped storage shapes", () => {
  for (const [value, expected] of [
    [
      [
        { text: "open" },
        { text: "done", done: true },
        { text: "explicit open", done: false },
      ],
      2,
    ] as const,
    [{ tasks: [{ text: "open" }, { text: "done", done: true }] }, 1] as const,
  ]) {
    const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-task-count-"));
    try {
      writeFileSync(join(dataDir, "tasks.json"), JSON.stringify(value));
      assert.equal(openTaskCount(dataDir), expected);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

test("openTaskCount preserves truthy legacy done semantics", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-task-count-"));
  try {
    writeFileSync(
      join(dataDir, "tasks.json"),
      JSON.stringify([
        { text: "numeric done", done: 1 },
        { text: "string done", done: "yes" },
        { text: "boolean done", done: true },
        { text: "explicit open", done: false },
        { text: "open" },
      ]),
    );
    assert.equal(openTaskCount(dataDir), 2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
