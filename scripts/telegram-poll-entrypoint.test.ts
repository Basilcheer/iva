import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shimPath = join(root, "scripts", "telegram-poll.mjs");
const shimUrl = pathToFileURL(shimPath).href;

function envWithoutTelegramCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  return env;
}

void test("importing the telegram poll shim is a silent no-op", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(shimUrl)})`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: envWithoutTelegramCredentials(),
      timeout: 10_000,
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

void test("direct telegram poll failure keeps its fatal message and exit status", () => {
  const result = spawnSync(process.execPath, [shimPath], {
    cwd: root,
    encoding: "utf8",
    env: envWithoutTelegramCredentials(),
    timeout: 10_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^telegram-poll fatal: Error: no TELEGRAM_BOT_TOKEN in \.env — nothing to poll\n/u,
  );
});
