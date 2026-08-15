import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit, rejectExit) => {
    let settled = false;
    const finish = (
      result: { code: number | null; signal: NodeJS.Signals | null } | Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (result instanceof Error) rejectExit(result);
      else resolveExit(result);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ code, signal });
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for child ${child.pid} exit`)),
      timeoutMs,
    );
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

void test("SIGKILL startup matrix never authorizes a repeated backlog drop", async (t) => {
  const cases = [
    ["hold-before-marker", "DROP"],
    ["hold-after-marker", "AMBIGUOUS"],
    ["hold-after-drop", "AMBIGUOUS"],
    ["hold-after-offset", "RESUME"],
  ] as const;

  for (const [mode, expected] of cases) {
    await t.test(mode, async (caseTest) => {
      const directory = await mkdtemp(join(tmpdir(), "iva-startup-crash-"));
      caseTest.after(() => rm(directory, { recursive: true, force: true }));
      const child = spawn(process.execPath, [CHILD, mode, directory], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      caseTest.after(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      });

      await waitForFile(join(directory, "boundary-ready"));
      assert.equal(
        existsSync(join(directory, "telegram-backlog-drop.json")),
        mode !== "hold-before-marker",
      );
      assert.equal(
        existsSync(join(directory, "drop-attempted")),
        mode === "hold-after-drop",
      );
      assert.equal(
        existsSync(join(directory, "telegram-offset.json")),
        mode === "hold-after-offset",
      );
      const exitPromise = waitForExit(child);
      assert.equal(child.kill("SIGKILL"), true);
      assert.deepEqual(
        await exitPromise,
        { code: null, signal: "SIGKILL" },
        stderr,
      );

      const probe = spawnSync(process.execPath, [CHILD, "probe", directory], {
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout, `${expected}\n`);
    });
  }
});
