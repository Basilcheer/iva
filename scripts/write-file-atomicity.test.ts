/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SIZE = 64 * 1024 * 1024;

async function waitForPartialTarget(
  child: ChildProcess,
  file: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const size = statSync(file).size;
    if (size !== SIZE) return true;
    assert.equal(child.exitCode, null, "writer exited before SIGKILL");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}

test("SIGKILL during write_file never leaves a partial CORE.md", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "iva-write-file-atomicity-"));
  const file = join(directory, "CORE.md");
  const before = "A".repeat(SIZE);
  const after = "B".repeat(SIZE);
  writeFileSync(file, before);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const hookUrl = new URL("./lib/ts-esm-hooks.ts", import.meta.url).href;
  const toolUrl = new URL("../agent/tools/write_file.ts", import.meta.url).href;
  const source = [
    `await import(${JSON.stringify(hookUrl)});`,
    `const { default: tool } = await import(${JSON.stringify(toolUrl)});`,
    "const [file, size] = process.argv.slice(1);",
    'const content = "B".repeat(Number(size));',
    'process.stdout.write("ready\\n");',
    "for (;;) await tool.execute({ path: file, content });",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, file, String(SIZE)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() =>
      assert.fail(`writer exited before ready: ${stderr}`),
    ),
  ]);

  await waitForPartialTarget(child, file, 1_000);
  assert.equal(child.kill("SIGKILL"), true, stderr);
  await once(child, "exit");

  const survived = readFileSync(file, "utf8");
  assert.ok(
    survived === before || survived === after,
    `CORE.md contains a partial write (${survived.length}/${SIZE} bytes)`,
  );
});
