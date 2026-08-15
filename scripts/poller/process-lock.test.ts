import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import {
  acquireTelegramProcessLock,
  parseTelegramGuardHolderMarker,
  parseTelegramProcessOwner,
  readProcessStartIdentity,
  telegramProcessOwnerIsLive,
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
  mode: "hold" | "kill-holder" | "kill-logical-holder" | "kill-state-holder",
  dataDir: string,
  {
    botId = "71020",
    guardBaseDir,
  }: { botId?: string; guardBaseDir?: string } = {},
) {
  const args = [CHILD, mode, dataDir, botId];
  if (guardBaseDir !== undefined) args.push(guardBaseDir);
  const state: RunningChild = {
    child: spawn(process.execPath, args, {
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

function readyEvidence(state: RunningChild): {
  botId: string;
  guardRoot: string;
  logicalGuardRoot: string;
  stateGuardRoot: string;
  lockFile: string;
  logicalLockFile: string;
  stateLockFile: string;
  guardOwnerFile: string;
  logicalGuardOwnerFile: string;
  stateGuardOwnerFile: string;
  holderPid: number;
  logicalHolderPid: number;
  stateHolderPid: number;
} {
  const line = state.stdout
    .split("\n")
    .find((candidate) => candidate.includes('"event":"READY"'));
  assert.ok(line, `missing READY evidence: ${state.stderr}`);
  return JSON.parse(line) as {
    botId: string;
    guardRoot: string;
    logicalGuardRoot: string;
    stateGuardRoot: string;
    lockFile: string;
    logicalLockFile: string;
    stateLockFile: string;
    guardOwnerFile: string;
    logicalGuardOwnerFile: string;
    stateGuardOwnerFile: string;
    holderPid: number;
    logicalHolderPid: number;
    stateHolderPid: number;
  };
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
    schema: "iva-telegram-poll-owner/v2",
    pid: process.pid,
    processStart: currentStart,
    nonce: "a".repeat(32),
  };
  assert.deepEqual(parseTelegramProcessOwner(JSON.stringify(owner)), owner);
  for (const invalid of [
    { ...owner, pid: 0 },
    { ...owner, processStart: "" },
    { ...owner, nonce: "short" },
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
        assert.match(owner.nonce, /^[0-9a-f]{32}$/u);
        assert.deepEqual(Object.keys(owner).sort(), [
          "nonce",
          "pid",
          "processStart",
          "schema",
        ]);
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }),
    { seed: SEED, numRuns: 2_000 },
  );
});

void test("guard holder marker contains only bot and process identity", () => {
  const holder = {
    schema: "iva-telegram-poll-holder/v2",
    scope: "bot",
    identity: "71011",
    pid: process.pid,
    processStart: readProcessStartIdentity(process.pid),
    nonce: "b".repeat(32),
  };
  assert.ok(holder.processStart);
  const marker = `iva-telegram-poll-holder-v2=${Buffer.from(
    JSON.stringify(holder),
  ).toString("base64url")}`;
  assert.deepEqual(parseTelegramGuardHolderMarker(marker), holder);
  assert.equal(marker.includes("test-token"), false);
});

void test("logical guard holder marker accepts only a path hash", () => {
  const configuredPath = "/private/configured/telegram-state";
  const holder = {
    schema: "iva-telegram-poll-holder/v2",
    scope: "logical",
    identity: "c".repeat(64),
    pid: process.pid,
    processStart: readProcessStartIdentity(process.pid),
    nonce: "d".repeat(32),
  };
  assert.ok(holder.processStart);
  const marker = `iva-telegram-poll-holder-v2=${Buffer.from(
    JSON.stringify(holder),
  ).toString("base64url")}`;
  assert.deepEqual(parseTelegramGuardHolderMarker(marker), holder);
  assert.equal(marker.includes(configuredPath), false);

  const invalid = {
    ...holder,
    identity: configuredPath,
  };
  assert.throws(
    () =>
      parseTelegramGuardHolderMarker(
        `iva-telegram-poll-holder-v2=${Buffer.from(
          JSON.stringify(invalid),
        ).toString("base64url")}`,
      ),
    /invalid Telegram guard holder marker/u,
  );
});

void test("property: arbitrary holder markers fail or satisfy the full public schema", () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      try {
        const holder = parseTelegramGuardHolderMarker(raw);
        assert.ok(
          (holder.scope === "bot" && /^[1-9][0-9]*$/u.test(holder.identity)) ||
            (holder.scope === "logical" &&
              /^[0-9a-f]{64}$/u.test(holder.identity)) ||
            (holder.scope === "state" &&
              /^[0-9]+:[0-9]+$/u.test(holder.identity)),
        );
        assert.ok(Number.isSafeInteger(holder.pid) && holder.pid > 0);
        assert.match(holder.nonce, /^[0-9a-f]{32}$/u);
        assert.equal(holder.schema, "iva-telegram-poll-holder/v2");
        assert.deepEqual(Object.keys(holder).sort(), [
          "identity",
          "nonce",
          "pid",
          "processStart",
          "schema",
          "scope",
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
  const guardBaseDir = join(root, "guard");
  const contenders = [
    startChild(t, "hold", firstAlias, {
      botId: "71021",
      guardBaseDir,
    }),
    startChild(t, "hold", secondAlias, {
      botId: "71022",
      guardBaseDir,
    }),
  ];

  await waitFor(
    () =>
      contenders.every(
        ({ child, stdout }) =>
          stdout.includes('"event":"READY"') ||
          child.exitCode !== null ||
          child.signalCode !== null,
      ),
    `concurrent acquisition did not settle: ${contenders.map((one) => one.stderr).join(" | ")}`,
  );
  assert.equal(
    contenders.filter((state) => state.stdout.includes('"event":"READY"'))
      .length,
    1,
    "physical aliases must have exactly one owner",
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
    const candidate = startChild(t, "hold", secondAlias, {
      botId: "71023",
      guardBaseDir,
    });
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

void test("an active owner cannot be bypassed by replacing the lock inode", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-lock-inode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const guardBaseDir = join(root, "guard");
  const first = startChild(t, "hold", dataDir, {
    botId: "71001",
    guardBaseDir,
  });
  await waitFor(
    () => first.stdout.includes('"event":"READY"'),
    `first owner did not acquire: ${first.stderr}`,
  );

  rmSync(readyEvidence(first).lockFile, { force: true });
  const second = startChild(t, "hold", dataDir, {
    botId: "71001",
    guardBaseDir,
  });
  await waitFor(
    () =>
      second.stdout.includes('"event":"READY"') ||
      second.child.exitCode !== null ||
      second.child.signalCode !== null,
    `replacement contender did not settle: ${second.stderr}`,
  );

  assert.equal(
    second.stdout.includes('"event":"READY"'),
    false,
    `both owners became active: first=${first.child.pid}, second=${second.child.pid}`,
  );
  assert.equal((await waitForExit(second.child)).code, 1, second.stderr);
  assert.equal(
    first.child.exitCode,
    null,
    "the original owner must remain active",
  );
});

void test("the same configured DATA_DIR conflicts across retarget for different bots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-lock-retarget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const firstTarget = join(root, "first");
  const secondTarget = join(root, "second");
  const configuredDataDir = join(root, "configured-data");
  const guardBaseDir = join(root, "guard");
  mkdirSync(firstTarget);
  mkdirSync(secondTarget);
  symlinkSync(firstTarget, configuredDataDir, "dir");

  const first = startChild(t, "hold", configuredDataDir, {
    botId: "71002",
    guardBaseDir,
  });
  await waitFor(
    () => first.stdout.includes('"event":"READY"'),
    `first owner did not acquire: ${first.stderr}`,
  );
  const logicalHolder = readyEvidence(first).logicalHolderPid;
  const holderCommand = spawnSync(
    "/bin/ps",
    ["-o", "command=", "-p", String(logicalHolder)],
    { encoding: "utf8" },
  );
  assert.equal(holderCommand.status, 0, holderCommand.stderr);
  assert.match(holderCommand.stdout, /iva-telegram-poll-holder-v2=/u);
  assert.equal(holderCommand.stdout.includes(configuredDataDir), false);
  assert.equal(holderCommand.stdout.includes("test-token"), false);
  rmSync(configuredDataDir);
  symlinkSync(secondTarget, configuredDataDir, "dir");

  const second = startChild(t, "hold", configuredDataDir, {
    botId: "71902",
    guardBaseDir,
  });
  await waitFor(
    () =>
      second.stdout.includes('"event":"READY"') ||
      second.child.exitCode !== null ||
      second.child.signalCode !== null,
    `retargeted contender did not settle: ${second.stderr}`,
  );

  assert.equal(
    second.stdout.includes('"event":"READY"'),
    false,
    `both owners became active: first=${first.child.pid}, second=${second.child.pid}`,
  );
  assert.equal((await waitForExit(second.child)).code, 1, second.stderr);
  assert.equal(
    existsSync(join(secondTarget, "telegram-poll-owner.json")),
    false,
    "the rejected contender must not touch retargeted state",
  );
});

void test("replacing the guard root cannot bypass its active holder", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-guard-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const guardBaseDir = join(root, "guard");
  const first = startChild(t, "hold", join(root, "first-data"), {
    botId: "71003",
    guardBaseDir,
  });
  await waitFor(
    () => first.stdout.includes('"event":"READY"'),
    `first owner did not acquire: ${first.stderr}`,
  );
  const evidence = readyEvidence(first);
  renameSync(evidence.guardRoot, `${evidence.guardRoot}.old`);
  mkdirSync(evidence.guardRoot);

  const secondDataDir = join(root, "second-data");
  const second = startChild(t, "hold", secondDataDir, {
    botId: "71003",
    guardBaseDir,
  });
  await waitFor(
    () =>
      second.stdout.includes('"event":"READY"') ||
      second.child.exitCode !== null ||
      second.child.signalCode !== null,
    `guard-root contender did not settle: ${second.stderr}`,
  );
  assert.equal(second.stdout.includes('"event":"READY"'), false);
  assert.equal((await waitForExit(second.child)).code, 1, second.stderr);
  assert.equal(existsSync(secondDataDir), false);
});

void test("replacing both guard owner and lock cannot bypass the live process identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-guard-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const guardBaseDir = join(root, "guard");
  const first = startChild(t, "hold", dataDir, {
    botId: "71004",
    guardBaseDir,
  });
  await waitFor(
    () => first.stdout.includes('"event":"READY"'),
    `first owner did not acquire: ${first.stderr}`,
  );
  const evidence = readyEvidence(first);
  writeFileSync(evidence.guardOwnerFile, "foreign owner\n");
  rmSync(evidence.lockFile, { force: true });

  const second = startChild(t, "hold", dataDir, {
    botId: "71004",
    guardBaseDir,
  });
  await waitFor(
    () =>
      second.stdout.includes('"event":"READY"') ||
      second.child.exitCode !== null ||
      second.child.signalCode !== null,
    `owner-replacement contender did not settle: ${second.stderr}`,
  );
  assert.equal(second.stdout.includes('"event":"READY"'), false);
  assert.equal((await waitForExit(second.child)).code, 1, second.stderr);
  assert.equal(first.child.exitCode, null);
});

void test("replacing the logical-state guard cannot bypass a retargeted path", async (t) => {
  const mutations = ["lock", "owner-and-lock", "root"] as const;
  for (const [index, mutation] of mutations.entries()) {
    await t.test(mutation, async (caseTest) => {
      const root = mkdtempSync(
        join(tmpdir(), `iva-process-logical-${mutation}-`),
      );
      caseTest.after(() => rmSync(root, { recursive: true, force: true }));
      const firstTarget = join(root, "first");
      const secondTarget = join(root, "second");
      const configuredDataDir = join(root, "configured-data");
      const guardBaseDir = join(root, "guard");
      mkdirSync(firstTarget);
      mkdirSync(secondTarget);
      symlinkSync(firstTarget, configuredDataDir, "dir");
      const first = startChild(caseTest, "hold", configuredDataDir, {
        botId: String(71_070 + index * 2),
        guardBaseDir,
      });
      await waitFor(
        () => first.stdout.includes('"event":"READY"'),
        `first logical owner did not acquire: ${first.stderr}`,
      );
      const evidence = readyEvidence(first);
      if (mutation === "root") {
        renameSync(
          evidence.logicalGuardRoot,
          `${evidence.logicalGuardRoot}.old`,
        );
        mkdirSync(evidence.logicalGuardRoot);
      } else {
        if (mutation === "owner-and-lock") {
          writeFileSync(evidence.logicalGuardOwnerFile, "foreign owner\n");
        }
        rmSync(evidence.logicalLockFile, { force: true });
      }
      rmSync(configuredDataDir);
      symlinkSync(secondTarget, configuredDataDir, "dir");

      const second = startChild(caseTest, "hold", configuredDataDir, {
        botId: String(71_071 + index * 2),
        guardBaseDir,
      });
      await waitFor(
        () =>
          second.stdout.includes('"event":"READY"') ||
          second.child.exitCode !== null ||
          second.child.signalCode !== null,
        `logical-guard contender did not settle: ${second.stderr}`,
      );
      assert.equal(second.stdout.includes('"event":"READY"'), false);
      assert.equal((await waitForExit(second.child)).code, 1, second.stderr);
      assert.equal(first.child.exitCode, null);
      assert.equal(
        existsSync(join(secondTarget, "telegram-poll-owner.json")),
        false,
      );
    });
  }
});

void test("replacing the physical-state guard cannot admit another bot", async (t) => {
  const mutations = ["lock", "owner-and-lock", "root"] as const;
  for (const [index, mutation] of mutations.entries()) {
    await t.test(mutation, async (caseTest) => {
      const root = mkdtempSync(
        join(tmpdir(), `iva-process-state-${mutation}-`),
      );
      caseTest.after(() => rmSync(root, { recursive: true, force: true }));
      const dataDir = join(root, "data");
      const firstAlias = join(root, "first-alias");
      const secondAlias = join(root, "second-alias");
      mkdirSync(dataDir);
      symlinkSync(dataDir, firstAlias, "dir");
      symlinkSync(dataDir, secondAlias, "dir");
      const guardBaseDir = join(root, "guard");
      const first = startChild(caseTest, "hold", firstAlias, {
        botId: String(71_040 + index * 2),
        guardBaseDir,
      });
      await waitFor(
        () => first.stdout.includes('"event":"READY"'),
        `first state owner did not acquire: ${first.stderr}`,
      );
      const evidence = readyEvidence(first);
      if (mutation === "root") {
        renameSync(evidence.stateGuardRoot, `${evidence.stateGuardRoot}.old`);
        mkdirSync(evidence.stateGuardRoot);
      } else {
        if (mutation === "owner-and-lock") {
          writeFileSync(evidence.stateGuardOwnerFile, "foreign owner\n");
        }
        rmSync(evidence.stateLockFile, { force: true });
      }

      const second = startChild(caseTest, "hold", secondAlias, {
        botId: String(71_041 + index * 2),
        guardBaseDir,
      });
      await waitFor(
        () =>
          second.stdout.includes('"event":"READY"') ||
          second.child.exitCode !== null ||
          second.child.signalCode !== null,
        `state-guard contender did not settle: ${second.stderr}`,
      );
      assert.equal(second.stdout.includes('"event":"READY"'), false);
      assert.equal((await waitForExit(second.child)).code, 1, second.stderr);
      assert.equal(first.child.exitCode, null);
    });
  }
});

void test("different Telegram bot identities use independent guard roots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-bot-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const guardBaseDir = join(root, "guard");
  const first = startChild(t, "hold", join(root, "first-data"), {
    botId: "71005",
    guardBaseDir,
  });
  const second = startChild(t, "hold", join(root, "second-data"), {
    botId: "71006",
    guardBaseDir,
  });
  await waitFor(
    () =>
      first.stdout.includes('"event":"READY"') &&
      second.stdout.includes('"event":"READY"'),
    `independent bot guards did not acquire: ${first.stderr} | ${second.stderr}`,
  );
  assert.notEqual(
    readyEvidence(first).guardRoot,
    readyEvidence(second).guardRoot,
  );
});

void test("different bots cannot own the same physical DATA_DIR", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-state-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const guardBaseDir = join(root, "guard");
  const contenders = [
    startChild(t, "hold", dataDir, { botId: "71015", guardBaseDir }),
    startChild(t, "hold", dataDir, { botId: "71016", guardBaseDir }),
  ];
  await waitFor(
    () =>
      contenders.every(
        ({ child, stdout }) =>
          stdout.includes('"event":"READY"') ||
          child.exitCode !== null ||
          child.signalCode !== null,
      ),
    `state contenders did not settle: ${contenders.map(({ stderr }) => stderr).join(" | ")}`,
  );
  assert.equal(
    contenders.filter(({ stdout }) => stdout.includes('"event":"READY"'))
      .length,
    1,
    `both bots own the same physical state: ${JSON.stringify(
      contenders.map(({ child, stdout }) => ({
        pid: child.pid,
        ready: stdout.includes('"event":"READY"'),
      })),
    )}`,
  );
});

void test("the same Telegram bot identity conflicts across different DATA_DIR values", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-same-bot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const guardBaseDir = join(root, "guard");
  const first = startChild(t, "hold", join(root, "first-data"), {
    botId: "71012",
    guardBaseDir,
  });
  await waitFor(
    () => first.stdout.includes('"event":"READY"'),
    `first bot owner did not acquire: ${first.stderr}`,
  );
  const secondDataDir = join(root, "second-data");
  const second = startChild(t, "hold", secondDataDir, {
    botId: "71012",
    guardBaseDir,
  });
  await waitFor(
    () => second.child.exitCode !== null || second.child.signalCode !== null,
    `same-bot contender did not fail: ${second.stderr}`,
  );
  assert.equal((await waitForExit(second.child)).code, 1, second.stderr);
  assert.equal(second.stdout.includes('"event":"READY"'), false);
  assert.equal(existsSync(secondDataDir), false);
});

void test("a same-PID successor with a different start identity takes stale ownership", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-pid-reuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const botId = "71013";
  const guardBaseDir = join(root, "guard");
  const guardRoot = join(guardBaseDir, `bot-${botId}`);
  mkdirSync(guardRoot, { recursive: true, mode: 0o700 });
  const staleOwner = {
    schema: "iva-telegram-poll-owner/v2" as const,
    pid: process.pid,
    processStart: "Mon Jan 01 00:00:00 2001",
    nonce: "c".repeat(32),
  };
  writeFileSync(
    join(guardRoot, "telegram-poll-owner.json"),
    `${JSON.stringify(staleOwner)}\n`,
  );
  assert.equal(telegramProcessOwnerIsLive(staleOwner), false);

  const lease = await acquireTelegramProcessLock({
    dataDir: join(root, "data"),
    botId,
    guardBaseDir,
  });
  t.after(() => lease.close());
  assert.equal(lease.owner.pid, process.pid);
  assert.notEqual(lease.owner.processStart, staleOwner.processStart);
});

void test("a late release never removes a successor owner record", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-process-late-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lease = await acquireTelegramProcessLock({
    dataDir: join(root, "data"),
    botId: "71014",
    guardBaseDir: join(root, "guard"),
  });
  const successor = {
    schema: "iva-telegram-poll-owner/v2",
    pid: process.pid,
    processStart: readProcessStartIdentity(process.pid),
    nonce: "d".repeat(32),
  };
  assert.ok(successor.processStart);
  const successorBytes = `${JSON.stringify(successor)}\n`;
  for (const ownerFile of [
    lease.guardOwnerFile,
    lease.logicalGuardOwnerFile,
    lease.stateGuardOwnerFile,
  ]) {
    writeFileSync(ownerFile, successorBytes);
  }

  await lease.close();

  for (const ownerFile of [
    lease.guardOwnerFile,
    lease.logicalGuardOwnerFile,
    lease.stateGuardOwnerFile,
  ]) {
    assert.equal(readFileSync(ownerFile, "utf8"), successorBytes);
  }
});

void test("Bridge exits if any kernel lease child dies", async (t) => {
  for (const mode of [
    "kill-holder",
    "kill-logical-holder",
    "kill-state-holder",
  ] as const) {
    await t.test(mode, () => {
      const dataDir = mkdtempSync(join(tmpdir(), "iva-process-lock-loss-"));
      try {
        const result = spawnSync(process.execPath, [CHILD, mode, dataDir], {
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, /process lock holder exited unexpectedly/u);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  }
});

void test("holder death at each publication boundary cannot return an unguarded lease", async (t) => {
  for (const [holderIndex, scope] of ["bot", "logical", "state"].entries()) {
    await t.test(scope, async (caseTest) => {
      const root = mkdtempSync(
        join(tmpdir(), `iva-process-${scope}-acquire-race-`),
      );
      caseTest.after(() => rmSync(root, { recursive: true, force: true }));
      const holders: ChildProcess[] = [];
      let ownerWrites = 0;
      let leaseLostCalls = 0;

      await assert.rejects(
        acquireTelegramProcessLock({
          dataDir: join(root, "data"),
          botId: String(71_060 + holderIndex),
          guardBaseDir: join(root, "guard"),
          spawnImpl: (command, args, options) => {
            const holder = spawn(command, [...args], options);
            holders.push(holder);
            return holder;
          },
          writeOwnerImpl: async (file, data) => {
            ownerWrites++;
            if (ownerWrites === holderIndex + 1) {
              const holder = holders[holderIndex];
              assert.ok(holder);
              holder.kill("SIGKILL");
              assert.equal((await waitForExit(holder)).signal, "SIGKILL");
              return;
            }
            writeFileSync(file, data, { mode: 0o600 });
          },
          onLeaseLost: () => {
            leaseLostCalls++;
          },
        }),
        /holder exited during acquisition/u,
      );
      assert.equal(ownerWrites, holderIndex + 1);
      assert.equal(leaseLostCalls, 0);
      for (const prior of holders.slice(0, holderIndex)) {
        assert.equal((await waitForExit(prior)).code, 0);
      }
    });
  }
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
          botId: "71008",
          guardBaseDir: join(dataDir, ".guard"),
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

void test("deleteWebhook ok:false aborts before commands, offset, or polling", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-delete-webhook-false-"));
  try {
    const result = spawnSync(
      process.execPath,
      [MAIN_GUARD_CHILD, dataDir, "delete-webhook-false"],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stderr,
      /deleteWebhook failed.*fixture rejected deleteWebhook/u,
    );
    const calls = readFileSync(
      join(dataDir, "telegram-bot-api-calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string });
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["deleteWebhook"],
    );
    assert.equal(existsSync(join(dataDir, "telegram-offset.json")), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
