/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeVersion } from "./health-probe.ts";

const PROBE_PORT = 18730;

function versionDir(t: { after(fn: () => void): void }, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-health-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "server.mjs"), body);
  return dir;
}

/** A stand-in for the built server: it records where and how it was started. */
const SERVER = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.cwd(), "started.json"), JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  port: process.env.PORT,
  tag: process.env.IVA_PROBE_TAG,
}));
createServer((_request, response) => {
  response.writeHead(200).end("ok");
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

function probe(
  dir: string,
  extra: Record<string, string> = {},
  timeoutMs = 15_000,
) {
  return probeVersion({
    dir,
    port: PROBE_PORT,
    command: process.execPath,
    args: [join(dir, "server.mjs")],
    env: { IVA_PROBE_TAG: "probe", ...extra },
    timeoutMs,
    intervalMs: 50,
  });
}

test("a healthy build answers on the probe port and is stopped again", async (t) => {
  const dir = versionDir(t, SERVER);

  const result = await probe(dir);
  assert.equal(result.ok, true, result.log);

  const started = JSON.parse(
    readFileSync(join(dir, "started.json"), "utf8"),
  ) as { pid: number; cwd: string; port: string; tag: string };
  // Started from the version's own final directory - the same paths it will run on.
  assert.equal(realpathSync(started.cwd), realpathSync(dir));
  assert.equal(started.port, String(PROBE_PORT));
  assert.equal(started.tag, "probe");
  assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
});

test("a build that dies on start fails fast and reports its own output", async (t) => {
  const dir = versionDir(
    t,
    `process.stderr.write("Cannot find module '../scripts/lib/provider.ts'\\n");\nprocess.exit(1);\n`,
  );

  const began = Date.now();
  const result = await probe(dir, {}, 15_000);
  assert.equal(result.ok, false);
  assert.match(result.log, /Cannot find module/);
  assert.ok(
    Date.now() - began < 10_000,
    `a dead process must not be waited out: ${Date.now() - began}ms`,
  );
});

test("a build that never listens fails on the deadline and leaves no process behind", async (t) => {
  const dir = versionDir(
    t,
    `import { writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `writeFileSync(join(process.cwd(), "started.json"), JSON.stringify({ pid: process.pid }));\n` +
      `setInterval(() => {}, 1000);\n`,
  );

  const result = await probe(dir, {}, 1200);
  assert.equal(result.ok, false);
  assert.match(result.log, /did not become healthy/);
  const { pid } = JSON.parse(
    readFileSync(join(dir, "started.json"), "utf8"),
  ) as {
    pid: number;
  };
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a build that ignores SIGTERM is killed anyway", async (t) => {
  const dir = versionDir(
    t,
    `import { createServer } from "node:http";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `process.on("SIGTERM", () => {});\n` +
      `writeFileSync(join(process.cwd(), "started.json"), JSON.stringify({ pid: process.pid }));\n` +
      `createServer((_r, response) => response.writeHead(200).end("ok"))\n` +
      `  .listen(Number(process.env.PORT), "127.0.0.1");\n`,
  );

  const result = await probeVersion({
    dir,
    port: PROBE_PORT,
    command: process.execPath,
    args: [join(dir, "server.mjs")],
    timeoutMs: 15_000,
    intervalMs: 50,
    stopGraceMs: 200,
  });
  assert.equal(result.ok, true, result.log);
  const { pid } = JSON.parse(
    readFileSync(join(dir, "started.json"), "utf8"),
  ) as {
    pid: number;
  };
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a missing command is a failed probe, not a crash", async (t) => {
  const dir = versionDir(t, "");
  const result = await probeVersion({
    dir,
    port: PROBE_PORT,
    command: join(dir, "does-not-exist"),
    args: [],
    timeoutMs: 2000,
    intervalMs: 50,
  });
  assert.equal(result.ok, false);
  assert.match(result.log, /ENOENT|does-not-exist/);
  assert.equal(existsSync(join(dir, "started.json")), false);
});
