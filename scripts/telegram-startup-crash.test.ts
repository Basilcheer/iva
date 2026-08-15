import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CHILD = join(
  import.meta.dirname,
  "fixtures/telegram-startup-crash-child.ts",
);

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${file}`);
}

void test("SIGKILL after durable first-run marker cannot authorize a second backlog drop", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "iva-startup-crash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [CHILD, "prime", directory], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });

  await waitForFile(join(directory, "marker-durable"));
  child.kill("SIGKILL");
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  assert.deepEqual(exit, { code: null, signal: "SIGKILL" }, stderr);

  const verify = spawnSync(process.execPath, [CHILD, "verify", directory], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(verify.stdout, "AMBIGUOUS\n");
});
