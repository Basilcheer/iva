import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";

const {
  default: bash,
  deadlineWorkerRuntime,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} = await import("../agent/tools/bash.ts");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function readPid(file) {
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function isAlive(pid) {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPid(file, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid(file);
    if (pid !== null) return pid;
    await delay(10);
  }
  assert.fail(`child did not write its PID to ${file}`);
}

async function waitUntilGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(20);
  }
  return !isAlive(pid);
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runWithExhaustedFileDescriptors() {
  const script = String.raw`
    import { closeSync, openSync } from "node:fs";
    const { default: bash } = await import("./agent/tools/bash.ts");
    const descriptors = [];
    try {
      while (true) descriptors.push(openSync("/dev/null", "r"));
    } catch (error) {
      if (error?.code !== "EMFILE") throw error;
    }
    let result;
    try {
      result = await bash.execute({ command: ":", timeoutMs: 1_000 });
    } finally {
      for (const descriptor of descriptors) closeSync(descriptor);
    }
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawn(
    "bash",
    [
      "-c",
      'ulimit -n 64; exec "$1" --input-type=module -e "$2"',
      "bash",
      process.execPath,
      script,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { stdout, stderr, exitCode };
}

function termResistantCommand(pidFile, { asChild = false, detachIo = false } = {}) {
  const redirect = detachIo ? " </dev/null >/dev/null 2>&1" : "";
  const processCommand =
    `trap '' TERM HUP; printf '%s\\n' "$$" > ${shellQuote(pidFile)}; ` +
    `exec sleep 3600${redirect}`;
  if (!asChild) return processCommand;
  // Keep exec's /bin/sh as the timed process and make the TERM-resistant process
  // its child. A timeout must reap the whole tree, not only this outer shell.
  return `bash -c ${shellQuote(processCommand)} & wait`;
}

function escapedProcessGroupCommand(
  pidFile,
  { detachIo = false, wait = false } = {},
) {
  const redirect = detachIo ? " </dev/null >/dev/null 2>&1" : "";
  const escaped =
    `trap '' TERM HUP; printf '%s\\n' "$$" > ${shellQuote(pidFile)}; ` +
    "exec sleep 3600";
  return (
    `setsid sh -c ${shellQuote(escaped)}${redirect} & ` +
    `while [ ! -s ${shellQuote(pidFile)} ]; do sleep 0.01; done` +
    (wait ? "; wait" : "")
  );
}

function startFakeManager(requestFile, pidFile) {
  let managed = null;
  const poll = setInterval(() => {
    if (managed || !existsSync(requestFile)) return;
    managed = spawn("sleep", ["3600"], {
      detached: true,
      stdio: "ignore",
      // A manager starts the unit in its own process group.
      env: { PATH: process.env.PATH },
    });
    managed.unref();
    writeFileSync(pidFile, `${managed.pid}\n`);
  }, 5);
  return () => {
    clearInterval(poll);
    if (managed && isAlive(managed.pid)) process.kill(managed.pid, "SIGKILL");
  };
}

test("bash preserves stdout, stderr and the effective cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "iva-bash-normal-"));
  try {
    const result = await bash.execute({
      command: "printf stdout; printf stderr >&2",
      cwd,
      timeoutMs: 1_000,
    });
    assert.deepEqual(result, {
      stdout: "stdout",
      stderr: "stderr",
      exitCode: 0,
      cwd,
      truncated: undefined,
      timedOut: undefined,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash preserves an ordinary non-zero shell exit code", async () => {
  const result = await bash.execute({
    command: "printf failed >&2; exit 7",
    timeoutMs: 1_000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "failed");
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, undefined);
});

test("bash input schema rejects deadlines below the documented floor", () => {
  assert.equal(MIN_TIMEOUT_MS, 100);
  const rejected = bash.inputSchema.safeParse({
    command: ":",
    timeoutMs: MIN_TIMEOUT_MS - 1,
  });
  assert.equal(rejected.success, false);
  assert.match(rejected.error.issues[0].message, /100 ms/);
  assert.equal(
    bash.inputSchema.safeParse({ command: ":", timeoutMs: MIN_TIMEOUT_MS }).success,
    true,
  );
});

test("bash input schema enforces Node's maximum timer delay", () => {
  assert.equal(MAX_TIMEOUT_MS, 2_147_483_647);
  const rejected = bash.inputSchema.safeParse({
    command: ":",
    timeoutMs: MAX_TIMEOUT_MS + 1,
  });
  assert.equal(rejected.success, false);
  assert.match(rejected.error.issues[0].message, /2147483647 ms/);
  assert.equal(
    bash.inputSchema.safeParse({ command: ":", timeoutMs: MAX_TIMEOUT_MS }).success,
    true,
  );
});

test("direct execute rejects a deadline below the floor before spawning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-timeout-floor-"));
  const marker = join(dir, "spawned");
  try {
    const result = await bash.execute({
      command: `: > ${shellQuote(marker)}`,
      timeoutMs: MIN_TIMEOUT_MS - 1,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /timeoutMs.*100.*2147483647 ms/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("direct execute rejects a deadline above Node's timer limit before spawning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-timeout-ceiling-"));
  const marker = join(dir, "spawned");
  try {
    const result = await bash.execute({
      command: `: > ${shellQuote(marker)}`,
      timeoutMs: MAX_TIMEOUT_MS + 1,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /timeoutMs.*100.*2147483647 ms/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn resource failure returns a bounded result without an unhandled error", async () => {
  const child = await within(
    runWithExhaustedFileDescriptors(),
    3_000,
    "EMFILE regression process did not settle",
  );
  assert.equal(child.exitCode, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /EMFILE|too many open files/i);
  assert.equal(result.stderr.length <= 30_000, true);
});

test("worker initialization failure falls back without orphaning the child group", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-worker-init-"));
  const pidFile = join(dir, "shell.pid");
  t.mock.method(deadlineWorkerRuntime, "create", () => {
    throw new Error("injected Worker initialization failure");
  });
  const execution = bash.execute({
    command: `printf '%s\\n' "$$" > ${shellQuote(pidFile)}; sleep 3600`,
    timeoutMs: MIN_TIMEOUT_MS,
  });
  let pid = null;
  try {
    pid = await waitForPid(pidFile);
    const result = await within(
      execution,
      1_800,
      "main-thread deadline fallback did not settle after Worker init failure",
    );
    assert.equal(result.timedOut, true);
    assert.equal(await waitUntilGone(pid, 1_500), true);
  } finally {
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(-pid, "SIGKILL");
    await execution.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a delayed exit event does not turn an already-exited command into a timeout", async () => {
  const execution = bash.execute({ command: "exit 7", timeoutMs: 100 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  const result = await within(execution, 1_800, "delayed exit event did not settle");
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, undefined);
});

test("portable deadline probe recognizes an exited root while the main loop is blocked", async (t) => {
  const createWorker = deadlineWorkerRuntime.create;
  t.mock.method(deadlineWorkerRuntime, "create", (options) =>
    createWorker({
      ...options,
      workerData: {
        ...options.workerData,
        forcePortableProbe: true,
      },
    }),
  );
  const execution = bash.execute({ command: "exit 7", timeoutMs: MIN_TIMEOUT_MS });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  const result = await within(execution, 1_800, "portable deadline probe did not settle");
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, undefined);
});

test("minimum deadline is enforced while the Node event loop is blocked", async () => {
  const execution = bash.execute({
    command: "sleep 0.2; printf completed",
    timeoutMs: MIN_TIMEOUT_MS,
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const result = await within(execution, 1_800, "blocked event loop disabled the deadline");
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout.includes("completed"), false);
});

test("deadline checks the root PID rather than a surviving process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-root-pid-"));
  const pidFile = join(dir, "child.pid");
  const command =
    `${termResistantCommand(pidFile)} & ` +
    `while [ ! -s ${shellQuote(pidFile)} ]; do sleep 0.01; done; exit 7`;
  const execution = bash.execute({ command, timeoutMs: 100 });
  let pid = null;
  try {
    const pidDeadline = Date.now() + 500;
    while (!existsSync(pidFile) && Date.now() < pidDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    pid = readPid(pidFile);
    assert.notEqual(pid, null, "background child did not write its PID");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    const result = await within(execution, 1_800, "root PID deadline check did not settle");
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, undefined);
    assert.equal(await waitUntilGone(pid, 1_500), true);
  } finally {
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    await within(execution.catch(() => {}), 1_000, "root PID execution did not settle");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing fd 4 cannot crash bash execution or change its exit code", async () => {
  const result = await within(
    bash.execute({ command: "exec 4<&-; exit 9", timeoutMs: 1_000 }),
    1_800,
    "closing fd 4 prevented bash execution from settling",
  );
  assert.equal(result.exitCode, 9);
  assert.equal(result.timedOut, undefined);
});

test("closing fd 3 cannot turn a normal exit into a timeout", async () => {
  const result = await within(
    bash.execute({ command: "exec 3>&-; exit 0", timeoutMs: 1_000 }),
    1_800,
    "closing fd 3 prevented bash execution from settling",
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, undefined);
});

test("writing to fd 3 cannot disable the command deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-fd-spoof-"));
  const pidFile = join(dir, "shell.pid");
  const execution = bash.execute({
    command:
      `printf '%s\\n' "$$" > ${shellQuote(pidFile)}; ` +
      "(printf x >&3) 2>/dev/null || :; while :; do :; done",
    timeoutMs: 100,
  });
  let pid = null;
  try {
    pid = await waitForPid(pidFile);
    const result = await within(
      execution,
      1_800,
      "writing to fd 3 disabled the command deadline",
    );
    assert.equal(result.timedOut, true);
  } finally {
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(-pid, "SIGKILL");
    await within(execution.catch(() => {}), 1_000, "fd spoof execution did not settle");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash closes stdin so a command waiting for input receives EOF", async () => {
  const result = await bash.execute({
    command: "if IFS= read -r line; then printf unexpected; else printf stdin-closed; fi",
    timeoutMs: 1_000,
  });
  assert.equal(result.stdout, "stdin-closed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, undefined);
});

test("bash preserves the last 30000 characters of each output stream", async () => {
  const script =
    `process.stdout.write("prefix-" + "o".repeat(30000));` +
    `process.stderr.write("prefix-" + "e".repeat(30000));`;
  const result = await bash.execute({
    command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
    timeoutMs: 1_000,
  });
  assert.equal(result.stdout, "o".repeat(30_000));
  assert.equal(result.stderr, "e".repeat(30_000));
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, undefined);
});

test("normal calls do not accumulate cleanup timers", async () => {
  const timeoutHandles = () =>
    process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const before = timeoutHandles();
  const started = Date.now();
  for (let index = 0; index < 3; index++) {
    const result = await bash.execute({ command: ":", timeoutMs: 1_000 });
    assert.equal(result.exitCode, 0);
  }
  await delay(50);
  assert.equal(timeoutHandles() <= before, true, "completed bash calls leaked cleanup timers");
  assert.equal(Date.now() - started < 1_800, true, "normal calls performed unbounded cleanup work");
});

test("timeout resolves within two seconds when a child ignores SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-term-"));
  const pidFile = join(dir, "child.pid");
  const execution = bash.execute({
    command: termResistantCommand(pidFile),
    timeoutMs: 100,
  });
  let pid = null;
  try {
    pid = await waitForPid(pidFile);
    const result = await within(
      execution,
      1_800,
      "bash timeout did not resolve within 1800ms for a TERM-resistant child",
    );
    assert.equal(result.timedOut, true);
  } finally {
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    await within(execution.catch(() => {}), 1_000, "bash execution did not settle after test cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normal shell exit reaps a background TERM-resistant descendant in its group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-normal-reap-"));
  const pidFile = join(dir, "child.pid");
  const command = `${termResistantCommand(pidFile)} &`;
  let pid = null;
  try {
    const result = await within(
      bash.execute({ command, timeoutMs: 1_000 }),
      1_800,
      "bash did not settle after a normal shell exit with a background child",
    );
    pid = await waitForPid(pidFile);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, undefined);
    assert.equal(
      await waitUntilGone(pid, 1_500),
      true,
      `background child PID ${pid} survived its parent shell`,
    );
  } finally {
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("descendant cleanup after a normal shell exit does not report a timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-normal-deadline-"));
  const pidFile = join(dir, "child.pid");
  const command = `${termResistantCommand(pidFile, { detachIo: true })} &`;
  let pid = null;
  try {
    const result = await within(
      bash.execute({ command, timeoutMs: 100 }),
      1_800,
      "bash did not settle after cleanup crossed the command deadline",
    );
    pid = await waitForPid(pidFile);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, undefined);
    assert.equal(
      await waitUntilGone(pid, 1_500),
      true,
      `background child PID ${pid} survived cleanup after its parent exited`,
    );
  } finally {
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a setsid process outside the owned group cannot hold result pipes open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-setsid-bounded-"));
  const pidFile = join(dir, "child.pid");
  let pid = null;
  try {
    const result = await within(
      bash.execute({
        command: escapedProcessGroupCommand(pidFile),
        timeoutMs: 1_000,
      }),
      1_800,
      "a process outside the owned group held inherited output pipes open",
    );
    pid = await waitForPid(pidFile);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, undefined);
    assert.equal(isAlive(pid), true, "setsid must place the process outside the owned group");
  } finally {
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout settles when a setsid process outside the owned group inherits output pipes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-setsid-timeout-"));
  const pidFile = join(dir, "child.pid");
  const execution = bash.execute({
    command: escapedProcessGroupCommand(pidFile, { wait: true }),
    timeoutMs: 100,
  });
  let pid = null;
  try {
    pid = await waitForPid(pidFile);
    const result = await within(
      execution,
      1_800,
      "bash timeout did not settle after a setsid descendant inherited its pipes",
    );
    assert.equal(result.timedOut, true);
    assert.equal(isAlive(pid), true, "setsid must place the process outside the owned group");
  } finally {
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    await within(execution.catch(() => {}), 1_000, "bash execution did not settle after test cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout leaves no TERM-resistant child PID behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-reap-"));
  const pidFile = join(dir, "child.pid");
  const execution = bash.execute({
    command: termResistantCommand(pidFile, { asChild: true, detachIo: true }),
    timeoutMs: 100,
  });
  let pid = null;
  try {
    pid = await waitForPid(pidFile);
    const result = await within(execution, 1_800, "bash timeout did not settle");
    assert.equal(result.timedOut, true);
    assert.equal(
      await waitUntilGone(pid, 1_500),
      true,
      `TERM-resistant child PID ${pid} survived the timeout`,
    );
  } finally {
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    await execution.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fake-manager process outside the PGID remains outside bash cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-fake-manager-"));
  const requestFile = join(dir, "start.request");
  const pidFile = join(dir, "managed.pid");
  const stopManager = startFakeManager(requestFile, pidFile);
  let pid = null;
  try {
    const result = await bash.execute({
      command:
        `: > ${shellQuote(requestFile)}; ` +
        `while [ ! -s ${shellQuote(pidFile)} ]; do sleep 0.01; done`,
      timeoutMs: 2_000,
    });
    assert.equal(result.exitCode, 0);
    pid = await waitForPid(pidFile);
    assert.equal(isAlive(pid), true, "manager-owned work must outlive the requesting bash client");
  } finally {
    stopManager();
    pid ??= readPid(pidFile);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
