/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

const CHECK_PORT = join(import.meta.dirname, "check-port.mjs");

test("check-port rejects an out-of-range explicit port", () => {
  const result = spawnSync(process.execPath, [CHECK_PORT, "70000"], {
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Invalid port: 70000\n");
});

test("check-port reports an occupied explicit port as JSON", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const result = spawnSync(
      process.execPath,
      [CHECK_PORT, String(address.port), "--json"],
      { encoding: "utf8" },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(`"port": ${address.port}`));
    assert.match(result.stdout, /"occupied": true/);
    assert.match(result.stdout, /"holders": \[/);
    assert.match(result.stdout, /"suggestion": \d+/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
