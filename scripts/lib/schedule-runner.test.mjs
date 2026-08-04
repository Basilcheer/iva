import { strict as assert } from "node:assert";
import test from "node:test";
import { spawn as realSpawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runScheduledJob } from "./schedule-runner.mjs";

async function scaffold() {
  const dir = await mkdtemp(join(tmpdir(), "iva-schedule-runner-"));
  // A real (empty) .env: the runner always spawns `node --env-file=.env <argv>`,
  // and --env-file requires the file to exist or node refuses to start.
  await writeFile(join(dir, ".env"), "", "utf8");
  return dir;
}

function collectLogs() {
  const lines = [];
  return { log: (...a) => lines.push(a.join(" ")), lines };
}

test("direct run (no lockPath): success writes lastSuccessAt and does not touch other entries", async (t) => {
  const root = await scaffold();
  t.after(() => {});
  await writeFile(join(root, "ok.mjs"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(statusPath, JSON.stringify({ "memory-weekly": { lastSuccessAt: 111 } }), "utf8");

  const { log, lines } = collectLogs();
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.mjs"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(status["memory-weekly"].lastSuccessAt, 111, "other entries are preserved");
  assert.ok(status["memory-daily"].lastSuccessAt > 0);
  assert.equal(status["memory-daily"].lastExitCode, 0);
  assert.ok(status["memory-daily"].lastStartedAt <= status["memory-daily"].lastFinishedAt);
  assert.ok(lines.some((l) => l.includes("memory-daily") && l.includes("start")), "logs a start line");
  assert.ok(!existsSync(`${statusPath}.tmp`), "no stray tmp file left behind");
});

test("non-zero exit: lastExitCode recorded, lastSuccessAt left untouched", async () => {
  const root = await scaffold();
  await writeFile(join(root, "fail.mjs"), "process.exit(7);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(statusPath, JSON.stringify({ "memory-daily": { lastSuccessAt: 42 } }), "utf8");

  const { log } = collectLogs();
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["fail.mjs"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 7);
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(status["memory-daily"].lastExitCode, 7);
  assert.equal(status["memory-daily"].lastSuccessAt, 42, "a failed run must not bump lastSuccessAt");
});

test("guard: a lastSuccessAt inside the 2h window skips the job without spawning", async () => {
  const root = await scaffold();
  await writeFile(join(root, "boom.mjs"), "process.exit(1);\n"); // would fail loudly if actually spawned
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  const recentSuccess = Date.now() - 5 * 60 * 1000; // 5 minutes ago
  await writeFile(statusPath, JSON.stringify({ "memory-daily": { lastSuccessAt: recentSuccess } }), "utf8");

  let spawned = false;
  const { log, lines } = collectLogs();
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["boom.mjs"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
    spawnImpl: (...args) => {
      spawned = true;
      return realSpawn(...args);
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(spawned, false, "the guard must prevent spawning entirely");
  assert.ok(lines.some((l) => l.toLowerCase().includes("skip")));
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(status["memory-daily"].lastSuccessAt, recentSuccess, "guard does not touch the status file");
});

test("guard: a lastSuccessAt older than 2h runs normally", async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.mjs"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });
  const oldSuccess = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
  await writeFile(statusPath, JSON.stringify({ "memory-daily": { lastSuccessAt: oldSuccess } }), "utf8");

  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.mjs"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log: () => {},
  });

  assert.equal(result.skipped, false);
  assert.equal(result.ok, true);
});

test("lockPath given: the spawned command is flock-wrapped in the documented shape", async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.mjs"), "process.exit(0);\n");
  const lockPath = join(root, ".memory.lock");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });

  let seen = null;
  const result = await runScheduledJob({
    name: "memory-weekly",
    argv: ["scripts/memory/rollup.ts", "weekly"],
    root,
    nodeBin: "/usr/bin/node-stand-in",
    lockPath,
    statusPath,
    log: () => {},
    spawnImpl: (cmd, args, opts) => {
      seen = { cmd, args, opts };
      // Actually run something trivial regardless of the (unrunnable) recorded command,
      // so the promise still settles quickly and deterministically.
      return realSpawn(process.execPath, [join(root, "ok.mjs")], opts);
    },
  });

  assert.equal(seen.cmd, "flock");
  assert.deepEqual(
    seen.args,
    ["-w", "900", lockPath, "/usr/bin/node-stand-in", "--env-file=.env", "scripts/memory/rollup.ts", "weekly"],
  );
  assert.equal(seen.opts.cwd, root);
  assert.equal(result.ok, true);
});

test("no lockPath: the spawned command invokes nodeBin directly (digest case)", async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.mjs"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");

  let seen = null;
  await runScheduledJob({
    name: "digest",
    argv: ["scripts/daily-digest.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log: () => {},
    spawnImpl: (cmd, args, opts) => {
      seen = { cmd, args };
      return realSpawn(process.execPath, [join(root, "ok.mjs")], opts);
    },
  });

  assert.equal(seen.cmd, process.execPath);
  assert.deepEqual(seen.args, ["--env-file=.env", "scripts/daily-digest.ts"]);
});

test("full flock integration (real /usr/bin/flock): success path end to end", { skip: !existsSync("/usr/bin/flock") }, async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.mjs"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  await mkdir(join(root, "data"), { recursive: true });

  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.mjs"],
    root,
    nodeBin: process.execPath,
    lockPath: join(root, ".memory.lock"),
    statusPath,
    log: () => {},
  });

  assert.equal(result.ok, true);
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(status["memory-daily"].lastExitCode, 0);
});

test("timeout: SIGTERM first, escalates to SIGKILL after the grace window", async () => {
  const root = await scaffold();
  // Ignores SIGTERM and spins forever — forces the SIGKILL escalation.
  await writeFile(
    join(root, "stubborn.mjs"),
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
  );
  const statusPath = join(root, "data/rollup-status.json");

  const { log, lines } = collectLogs();
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["stubborn.mjs"],
    root,
    nodeBin: process.execPath,
    statusPath,
    log,
    timeoutMs: 150,
    killGraceMs: 150,
  });

  assert.equal(result.ok, false);
  assert.notEqual(result.code, 0);
  assert.ok(lines.some((l) => l.includes("SIGTERM")));
  assert.ok(lines.some((l) => l.includes("SIGKILL")));
});

test("spawn failure (bad nodeBin) never throws and records the error", async () => {
  const root = await scaffold();
  const statusPath = join(root, "data/rollup-status.json");

  let threw = false;
  let result;
  try {
    result = await runScheduledJob({
      name: "memory-daily",
      argv: ["whatever"],
      root,
      nodeBin: join(root, "does-not-exist-binary"),
      statusPath,
      log: () => {},
    });
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "runScheduledJob must never throw");
  assert.equal(result.ok, false);
});
