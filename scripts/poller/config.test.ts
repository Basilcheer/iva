import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_URL = pathToFileURL(join(ROOT, "scripts/poller/config.mjs")).href;

interface ConfigSnapshot {
  readonly root: string;
  readonly node: string;
  readonly token: string | null;
  readonly botUserId: string | null;
  readonly botUsername: string;
  readonly port: string;
  readonly host: string;
  readonly dataDirRaw: string;
  readonly dataDir: string;
  readonly envPath: string;
  readonly route: string;
  readonly acceptanceRoute: string;
  readonly resetRoute: string;
  readonly api: string;
  readonly offsetFile: string;
  readonly directAcceptanceTimeoutMs: number;
  readonly settleMs: number | "NaN";
  readonly allowed: string[];
  readonly sleepSettledBefore: boolean;
  readonly sleepSettledAfter: boolean;
  readonly logArgs: unknown[];
}

const SNAPSHOT_PROGRAM = `
const config = await import(${JSON.stringify(CONFIG_URL)});
let sleepSettled = false;
const sleepPromise = config.sleep(1).then(() => {
  sleepSettled = true;
});
const sleepSettledBefore = sleepSettled;
await sleepPromise;
const originalLog = console.log;
let logArgs = [];
console.log = (...args) => {
  logArgs = args;
};
config.log("poller-config-log", 7);
console.log = originalLog;
process.stdout.write(JSON.stringify({
  root: config.ROOT,
  node: config.NODE,
  token: config.TOKEN ?? null,
  botUserId: config.BOT_USER_ID,
  botUsername: config.BOT_USERNAME,
  port: config.PORT,
  host: config.HOST,
  dataDirRaw: config.DATA_DIR_RAW,
  dataDir: config.DATA_DIR,
  envPath: config.ENV_PATH,
  route: config.ROUTE,
  acceptanceRoute: config.ACCEPTANCE_ROUTE,
  resetRoute: config.RESET_ROUTE,
  api: config.API,
  offsetFile: config.OFFSET_FILE,
  directAcceptanceTimeoutMs: config.DIRECT_ACCEPTANCE_TIMEOUT_MS,
  settleMs: Number.isNaN(config.SETTLE_MS) ? "NaN" : config.SETTLE_MS,
  allowed: [...config.ALLOWED],
  sleepSettledBefore,
  sleepSettledAfter: sleepSettled,
  logArgs,
}));
`;

function importConfig(
  env: Readonly<Record<string, string>> = {},
): Promise<ConfigSnapshot> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "--eval", SNAPSHOT_PROGRAM],
      { cwd: ROOT, env },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `config fixture failed: ${String(stderr).trim() || error.message}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(String(stdout)) as ConfigSnapshot);
        } catch (parseError) {
          reject(
            new Error(
              `config fixture emitted invalid JSON: ${String(parseError)}`,
            ),
          );
        }
      },
    );
  });
}

void test("poller config snapshots default root, routes, data, and helper behavior at import time", async () => {
  const config = await importConfig();

  assert.equal(config.root, ROOT);
  assert.equal(config.node, process.execPath);
  assert.equal(config.token, null);
  assert.equal(config.botUserId, null);
  assert.equal(config.botUsername, "my_bot");
  assert.equal(config.port, "8723");
  assert.equal(config.host, "http://127.0.0.1:8723");
  assert.equal(config.dataDirRaw, "data");
  assert.equal(config.dataDir, join(ROOT, "data"));
  assert.equal(config.envPath, join(ROOT, ".env"));
  assert.equal(config.route, "http://127.0.0.1:8723/eve/v1/telegram");
  assert.equal(
    config.acceptanceRoute,
    "http://127.0.0.1:8723/eve/v1/telegram/accepted",
  );
  assert.equal(
    config.resetRoute,
    "http://127.0.0.1:8723/eve/v1/telegram/reset",
  );
  assert.equal(config.api, "https://api.telegram.org/botundefined");
  assert.equal(config.offsetFile, join(ROOT, "data", "telegram-offset.json"));
  assert.equal(config.directAcceptanceTimeoutMs, 90_000);
  assert.equal(config.settleMs, 1500);
  assert.deepEqual(config.allowed, []);
  assert.equal(config.sleepSettledBefore, false);
  assert.equal(config.sleepSettledAfter, true);
  assert.equal(typeof config.logArgs[0], "string");
  assert.ok(!Number.isNaN(Date.parse(String(config.logArgs[0]))));
  assert.deepEqual(config.logArgs.slice(1), ["poller-config-log", 7]);
});

void test("poller config keeps explicit host, token, relative data, and allowlist normalization", async () => {
  const config = await importConfig({
    ASSISTANT_DATA_DIR: "runtime-data",
    ASSISTANT_HOST: "https://poll.example.test:9443/",
    IVA_PORT: "9123",
    TELEGRAM_ALLOWED_USER_IDS: " 10,20  20\n003 ",
    TELEGRAM_BOT_TOKEN: "123456:fixture",
    TELEGRAM_BOT_USERNAME: "fixture_bot",
    TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS: "123",
    TELEGRAM_POLL_SETTLE_MS: "17",
  });

  assert.equal(config.token, "123456:fixture");
  assert.equal(config.botUserId, "123456");
  assert.equal(config.botUsername, "fixture_bot");
  assert.equal(config.port, "9123");
  assert.equal(config.host, "https://poll.example.test:9443");
  assert.equal(config.dataDirRaw, "runtime-data");
  assert.equal(config.dataDir, join(ROOT, "runtime-data"));
  assert.equal(config.route, "https://poll.example.test:9443/eve/v1/telegram");
  assert.equal(
    config.acceptanceRoute,
    "https://poll.example.test:9443/eve/v1/telegram/accepted",
  );
  assert.equal(
    config.resetRoute,
    "https://poll.example.test:9443/eve/v1/telegram/reset",
  );
  assert.equal(config.api, "https://api.telegram.org/bot123456:fixture");
  assert.equal(config.directAcceptanceTimeoutMs, 123);
  assert.equal(config.settleMs, 17);
  assert.deepEqual(config.allowed, ["10", "20", "003"]);
});

void test("poller config preserves absolute data directories and removes exactly one host slash", async () => {
  const config = await importConfig({
    ASSISTANT_DATA_DIR: "/tmp/iva-config-fixture-data",
    ASSISTANT_HOST: "http://loopback.fixture//",
  });

  assert.equal(config.dataDirRaw, "/tmp/iva-config-fixture-data");
  assert.equal(config.dataDir, "/tmp/iva-config-fixture-data");
  assert.equal(config.host, "http://loopback.fixture/");
  assert.equal(config.route, "http://loopback.fixture//eve/v1/telegram");
});

void test("poller config bounds direct acceptance timeout but deliberately preserves settle Number coercion", async () => {
  const timeoutCases: ReadonlyArray<readonly [string | undefined, number]> = [
    [undefined, 90_000],
    ["1", 1],
    ["4294967295", 4_294_967_295],
    ["0", 90_000],
    ["-1", 90_000],
    ["1.5", 90_000],
    ["4294967296", 90_000],
    ["not-a-number", 90_000],
    ["", 90_000],
  ];

  for (const [raw, expected] of timeoutCases) {
    const config = await importConfig(
      raw === undefined ? {} : { TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS: raw },
    );
    assert.equal(config.directAcceptanceTimeoutMs, expected, raw);
  }

  assert.equal((await importConfig()).settleMs, 1500);
  assert.equal(
    (await importConfig({ TELEGRAM_POLL_SETTLE_MS: "0" })).settleMs,
    0,
  );
  assert.equal(
    (await importConfig({ TELEGRAM_POLL_SETTLE_MS: "-2" })).settleMs,
    -2,
  );
  assert.equal(
    (await importConfig({ TELEGRAM_POLL_SETTLE_MS: "bad" })).settleMs,
    "NaN",
  );
});
