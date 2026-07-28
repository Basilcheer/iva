import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigTransactionError,
  applyConfigTransaction,
  pendingConfigPath,
  recoverConfigTransaction,
} from "./config-transaction.mjs";

const OLD = "MODEL_PROVIDER=ollama\nOLLAMA_MODEL=old\nOLLAMA_API_KEY=old-secret\nIVA_PORT=8723\n";
const NEXT = "MODEL_PROVIDER=ollama\nOLLAMA_MODEL=new\nOLLAMA_API_KEY=new-secret\nIVA_PORT=8724\n";
const SELECTION = {
  provider: "ollama",
  model: "new",
  key: "new-secret",
  dataDir: "/tmp/unused",
};
const SERVICES = ["iva.service", "iva-telegram-poll.service"];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "iva-config-transaction-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, ".env");
  await writeFile(envPath, OLD, { mode: 0o600 });
  return { dir, envPath };
}

function healthyDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      validate: async (selection) => calls.push(["validate", selection.model]),
      restart: async (services) => calls.push(["restart", ...services]),
      health: async (url) => calls.push(["health", url]),
      ...overrides,
    },
  };
}

test("env write failure leaves old bytes and never reports success", async (t) => {
  const { envPath } = await fixture(t);
  const { calls, deps } = healthyDeps({
    writeEnv() {
      throw new Error("disk full");
    },
  });

  await assert.rejects(
    applyConfigTransaction({
      envPath,
      nextText: NEXT,
      selection: SELECTION,
      healthUrl: "http://127.0.0.1:8724/eve/v1/health",
      services: SERVICES,
    }, deps),
    (error) => error instanceof ConfigTransactionError && error.phase === "write",
  );

  assert.equal(await readFile(envPath, "utf8"), OLD);
  assert.deepEqual(calls.map((call) => call[0]), ["validate", "restart"]);
});
test("restart failure restores snapshot and restarts old services", async (t) => {
  const { envPath } = await fixture(t);
  let restarts = 0;
  const { deps } = healthyDeps({
    restart: async () => {
      restarts++;
      if (restarts === 1) throw new Error("restart failed");
    },
  });

  await assert.rejects(
    applyConfigTransaction({
      envPath,
      nextText: NEXT,
      selection: SELECTION,
      healthUrl: "http://127.0.0.1:8724/eve/v1/health",
      services: SERVICES,
    }, deps),
    (error) =>
      error instanceof ConfigTransactionError &&
      error.phase === "restart" &&
      error.rollbackFailed === false,
  );
  assert.equal(restarts, 2);
  assert.equal(await readFile(envPath, "utf8"), OLD);
  await assert.rejects(readFile(pendingConfigPath(envPath), "utf8"), { code: "ENOENT" });
});

test("health timeout rolls back the env and restarts old services", async (t) => {
  const { envPath } = await fixture(t);
  let restarts = 0;
  const { deps } = healthyDeps({
    restart: async () => { restarts++; },
    health: async () => {
      throw Object.assign(new Error("health timeout"), { code: "ETIMEDOUT" });
    },
  });

  await assert.rejects(
    applyConfigTransaction({
      envPath,
      nextText: NEXT,
      selection: SELECTION,
      healthUrl: "http://127.0.0.1:8724/eve/v1/health",
      services: SERVICES,
    }, deps),
    (error) => error instanceof ConfigTransactionError && error.phase === "health",
  );
  assert.equal(restarts, 2);
  assert.equal(await readFile(envPath, "utf8"), OLD);
});

test("successful apply validates, restarts both units, probes local health and commits", async (t) => {
  const { envPath } = await fixture(t);
  const { calls, deps } = healthyDeps();
  const result = await applyConfigTransaction({
    envPath,
    nextText: NEXT,
    selection: SELECTION,
    healthUrl: "http://127.0.0.1:8724/eve/v1/health",
    services: SERVICES,
  }, deps);

  assert.deepEqual(result, { committed: true });
  assert.equal(await readFile(envPath, "utf8"), NEXT);
  assert.deepEqual(calls, [
    ["validate", "new"],
    ["restart", ...SERVICES],
    ["health", "http://127.0.0.1:8724/eve/v1/health"],
  ]);
  assert.deepEqual((await readdir(join(envPath, ".."))).filter((name) => name.includes("transaction")), []);
});

test("failed rollback keeps the snapshot and gives a secret-free recovery instruction", async (t) => {
  const { envPath } = await fixture(t);
  let restarts = 0;
  const { deps } = healthyDeps({
    restart: async () => {
      restarts++;
      throw new Error(restarts === 1 ? "new-secret restart failure" : "old-secret rollback failure");
    },
  });

  const error = await applyConfigTransaction({
    envPath,
    nextText: NEXT,
    selection: SELECTION,
    healthUrl: "http://127.0.0.1:8724/eve/v1/health",
    services: SERVICES,
  }, deps).catch((caught) => caught);

  assert.equal(error.rollbackFailed, true);
  assert.match(error.message, /iva config --recover/);
  assert.doesNotMatch(error.message, /new-secret|old-secret/);
  assert.equal(await readFile(envPath, "utf8"), OLD);
  assert.equal(JSON.parse(await readFile(pendingConfigPath(envPath), "utf8")).version, 1);
});

test("a crash after env replacement is recovered from the durable snapshot", async (t) => {
  const { envPath } = await fixture(t);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { applyConfigTransaction } from ${JSON.stringify(new URL("./config-transaction.mjs", import.meta.url).href)};
        await applyConfigTransaction(
          ${JSON.stringify({
            envPath,
            nextText: NEXT,
            selection: SELECTION,
            healthUrl: "http://127.0.0.1:8724/eve/v1/health",
            services: SERVICES,
          })},
          {
            validate: async () => {},
            restart: async () => process.exit(73),
            health: async () => {},
          },
        );
      `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 73, child.stderr);
  assert.equal(await readFile(envPath, "utf8"), NEXT);
  assert.equal(JSON.parse(await readFile(pendingConfigPath(envPath), "utf8")).version, 1);

  const restarts = [];
  assert.equal(
    await recoverConfigTransaction(
      { envPath, services: SERVICES },
      { restart: async (services) => restarts.push(services) },
    ),
    true,
  );
  assert.equal(await readFile(envPath, "utf8"), OLD);
  assert.deepEqual(restarts, [SERVICES]);
  await assert.rejects(readFile(pendingConfigPath(envPath), "utf8"), { code: "ENOENT" });
});
