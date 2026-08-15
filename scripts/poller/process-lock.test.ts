import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import {
  acquireTelegramProcessLock,
  parseTelegramProcessOwner,
  readProcessStartIdentity,
} from "./process-lock.ts";
import { parseBacklogDropMarker } from "./startup-state.ts";

const CHILD = join(
  import.meta.dirname,
  "../fixtures/telegram-process-lock-child.ts",
);
const MAIN_GUARD_CHILD = join(
  import.meta.dirname,
  "../fixtures/telegram-main-guard-child.ts",
);
const SEED = 18_702;

type RunningChild = {
  child: ChildProcess;
  stdout: string;
  stderr: string;
};

function startChild(
  t: TestContext,
  mode: "hold" | "kill-holder",
  dataDir: string,
) {
  const state: RunningChild = {
    child: spawn(process.execPath, [CHILD, mode, dataDir], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
    stdout: "",
    stderr: "",
  };
  state.child.stdout?.setEncoding("utf8");
  state.child.stderr?.setEncoding("utf8");
  state.child.stdout?.on("data", (chunk: string) => {
    state.stdout += chunk;
  });
  state.child.stderr?.on("data", (chunk: string) => {
    state.stderr += chunk;
  });
  t.after(() => {
    if (state.child.exitCode === null && state.child.signalCode === null) {
      state.child.kill("SIGKILL");
    }
  });
  return state;
}

function startMainChild(t: TestContext, dataDir: string): RunningChild {
  const state: RunningChild = {
    child: spawn(process.execPath, [MAIN_GUARD_CHILD, dataDir], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
    stdout: "",
    stderr: "",
  };
  state.child.stdout?.setEncoding("utf8");
  state.child.stderr?.setEncoding("utf8");
  state.child.stdout?.on("data", (chunk: string) => {
    state.stdout += chunk;
  });
  state.child.stderr?.on("data", (chunk: string) => {
    state.stderr += chunk;
  });
  t.after(() => {
    if (state.child.exitCode === null && state.child.signalCode === null) {
      state.child.kill("SIGKILL");
    }
  });
  return state;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );
}

void test("process owner parser requires PID and OS start identity", () => {
  const currentStart = readProcessStartIdentity(process.pid);
  assert.ok(currentStart);
  const owner = {
    schema: "iva-telegram-poll-owner/v1",
    pid: process.pid,
    processStart: currentStart,
    token: "a".repeat(32),
  };
  assert.deepEqual(parseTelegramProcessOwner(JSON.stringify(owner)), owner);
  for (const invalid of [
    { ...owner, pid: 0 },
    { ...owner, processStart: "" },
    { ...owner, token: "short" },
    { ...owner, extra: true },
  ]) {
    assert.throws(
      () => parseTelegramProcessOwner(JSON.stringify(invalid)),
      /invalid Telegram process owner schema/u,
    );
  }
});

void test("property: arbitrary owner bytes either fail or satisfy the full identity schema", () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      try {
        const owner = parseTelegramProcessOwner(raw);
        assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0);
        assert.ok(owner.processStart.length > 0);
        assert.match(owner.token, /^[0-9a-f]{32}$/u);
        assert.deepEqual(Object.keys(owner).sort(), [
          "pid",
          "processStart",
          "schema",
          "token",
        ]);
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }),
    { seed: SEED, numRuns: 2_000 },
  );
});

void test("concurrent physical aliases admit one owner and parent SIGKILL releases the kernel lease", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "physical");
  const firstAlias = join(root, "first-alias");
  const secondAlias = join(root, "second-alias");
  mkdirSync(dataDir);
  symlinkSync(dataDir, firstAlias, "dir");
  symlinkSync(dataDir, secondAlias, "dir");
  const contenders = [
    startChild(t, "hold", firstAlias),
    startChild(t, "hold", secondAlias),
  ];

  await waitFor(
    () =>
      contenders.filter((state) => state.stdout.includes('"event":"READY"'))
        .length === 1 &&
      contenders.filter(
        (state) =>
          state.child.exitCode !== null || state.child.signalCode !== null,
      ).length === 1,
    `concurrent acquisition did not settle: ${contenders.map((one) => one.stderr).join(" | ")}`,
  );
  const winner = contenders.find((state) =>
    state.stdout.includes('"event":"READY"'),
  );
  const loser = contenders.find((state) => state !== winner);
  assert.ok(winner && loser);
  assert.equal((await waitForExit(loser.child)).code, 1, loser.stderr);

  winner.child.kill("SIGKILL");
  assert.equal((await waitForExit(winner.child)).signal, "SIGKILL");

  let successor: RunningChild | null = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = startChild(t, "hold", secondAlias);
    await waitFor(
      () =>
        candidate.stdout.includes('"event":"READY"') ||
        candidate.child.exitCode !== null ||
        candidate.child.signalCode !== null,
      "successor acquisition did not settle",
      2_000,
    );
    if (candidate.stdout.includes('"event":"READY"')) {
      successor = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(successor, "kernel lease did not recover after owner SIGKILL");
  const persisted = parseTelegramProcessOwner(
    readFileSync(join(dataDir, "telegram-poll-owner.json"), "utf8"),
  );
  assert.equal(persisted.pid, successor.child.pid);
  assert.equal(
    statSync(join(dataDir, "telegram-poll-owner.json")).mode & 0o777,
    0o600,
  );
});

void test("Bridge exits if its kernel lease child dies", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-process-lock-loss-"));
  try {
    const result = spawnSync(
      process.execPath,
      [CHILD, "kill-holder", dataDir],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /process lock holder exited unexpectedly/u);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

void test("a holder death during owner publication cannot return an unguarded lease", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-process-lock-acquire-race-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let holder: ChildProcess | null = null;
  let leaseLostCalls = 0;

  await assert.rejects(
    acquireTelegramProcessLock({
      dataDir,
      spawnImpl: (command, args, options) => {
        holder = spawn(command, [...args], options);
        return holder;
      },
      writeOwnerImpl: async () => {
        assert.ok(holder?.pid);
        holder.kill("SIGKILL");
        assert.equal((await waitForExit(holder)).signal, "SIGKILL");
      },
      onLeaseLost: () => {
        leaseLostCalls++;
      },
    }),
    /holder exited during acquisition/u,
  );
  assert.equal(leaseLostCalls, 0);
});

void test("a missing kernel-lock helper fails closed without hanging", async (t) => {
  const dataDir = mkdtempSync(
    join(tmpdir(), "iva-process-lock-missing-helper-"),
  );
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await assert.rejects(
      Promise.race([
        acquireTelegramProcessLock({
          dataDir,
          timeoutMs: 100,
          spawnImpl: (_command, _args, options) =>
            spawn("/iva/definitely-missing-lock-helper", [], options),
        }),
        new Promise((_, rejectTimeout) => {
          timeout = setTimeout(
            () => rejectTimeout(new Error("missing helper path hung")),
            1_000,
          );
        }),
      ]),
      /ENOENT/u,
    );
  } finally {
    clearTimeout(timeout);
  }
});

void test("OS lease permits exactly one ordered first-run drop attempt", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-main-guard-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const mainContenders = [
    startMainChild(t, dataDir),
    startMainChild(t, dataDir),
  ];

  await waitFor(
    () => {
      const firstCalls = readdirSync(dataDir).filter((name) =>
        name.startsWith("first-bot-api-"),
      );
      assert.ok(firstCalls.length <= 1, "both Bridge mains reached Bot API");
      return (
        firstCalls.length === 1 &&
        mainContenders.some(
          ({ child }) => child.exitCode !== null || child.signalCode !== null,
        )
      );
    },
    `main guard did not settle: ${mainContenders.map(({ stderr }) => stderr).join(" | ")}`,
  );

  const firstCalls = readdirSync(dataDir).filter((name) =>
    name.startsWith("first-bot-api-"),
  );
  assert.equal(firstCalls.length, 1);
  const evidence = JSON.parse(
    readFileSync(join(dataDir, firstCalls[0]), "utf8"),
  ) as {
    method?: unknown;
    body?: unknown;
    markerAtCall?: unknown;
    ownerAtCall?: unknown;
  };
  assert.equal(evidence.method, "deleteWebhook");
  assert.deepEqual(evidence.body, { drop_pending_updates: true });
  assert.deepEqual(parseBacklogDropMarker(String(evidence.markerAtCall)), {
    schema: "iva-telegram-backlog-drop/v1",
  });
  assert.equal(
    parseTelegramProcessOwner(String(evidence.ownerAtCall)).pid,
    Number(firstCalls[0].slice("first-bot-api-".length)),
  );
  const winnerPid = Number(firstCalls[0].slice("first-bot-api-".length));
  const winner = mainContenders.find(({ child }) => child.pid === winnerPid);
  const loser = mainContenders.find(({ child }) => child.pid !== winnerPid);
  assert.ok(winner && loser);
  assert.equal((await waitForExit(loser.child)).code, 1, loser.stderr);
  winner.child.kill("SIGKILL");
  assert.equal((await waitForExit(winner.child)).signal, "SIGKILL");

  const successor = startMainChild(t, dataDir);
  await waitFor(
    () =>
      successor.child.exitCode !== null || successor.child.signalCode !== null,
    `successor did not fail closed: ${successor.stderr}`,
  );
  assert.equal((await waitForExit(successor.child)).code, 1, successor.stderr);
  assert.match(successor.stderr, /marker exists without an offset/u);
  assert.equal(
    readdirSync(dataDir).filter((name) => name.startsWith("first-bot-api-"))
      .length,
    1,
  );
});
