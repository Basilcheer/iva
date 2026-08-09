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
import { createServer } from "node:http";
import { probeEnvironment, probeVersion } from "./health-probe.ts";

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

test("the probe environment is the service's, with the probe's own port", (t) => {
  const dir = versionDir(t, "");
  const env = join(dir, ".env");
  writeFileSync(
    env,
    "MODEL_PROVIDER=anthropic\nIVA_PORT=8723\n" +
      'TELEGRAM_BOT_TOKEN="42:secret"\n' +
      "ASSISTANT_DATA_DIR=/home/user/iva/data\n" +
      "ASSISTANT_VAULT_DIR=/home/user/iva/vault\n",
  );

  const probeEnv = probeEnvironment(env, 8901, dir);
  // What systemd hands the unit through EnvironmentFile - a probe without it
  // would prove a version starts under a configuration nobody runs.
  assert.equal(probeEnv.MODEL_PROVIDER, "anthropic");
  assert.equal(probeEnv.TELEGRAM_BOT_TOKEN, "42:secret");
  // Both spellings of the port name the probe's server, never the live one.
  assert.equal(probeEnv.PORT, "8901");
  assert.equal(probeEnv.IVA_PORT, "8901");
  assert.equal(probeEnv.IVA_HEALTH_PROBE, "1");
  // And the state it opens is the version's own, whatever absolute paths that
  // .env names: those are the live installation's, and a probe is thrown away.
  assert.equal(probeEnv.ASSISTANT_DATA_DIR, join(dir, "data"));
  assert.equal(probeEnv.ASSISTANT_VAULT_DIR, join(dir, "vault"));

  // An installation without an .env is still worth checking a version against.
  const bare = probeEnvironment(join(dir, "missing.env"), 8901, dir);
  assert.deepEqual(bare, {
    ASSISTANT_DATA_DIR: join(dir, "data"),
    ASSISTANT_VAULT_DIR: join(dir, "vault"),
    PORT: "8901",
    IVA_PORT: "8901",
    IVA_HEALTH_PROBE: "1",
  });
});

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

test("a foreign server on the probe port never passes for the version", async (t) => {
  // Two updates on one box can pick the same free port between checking it and
  // taking it, and then a crash-looping version gets a 200 from the other one.
  const squatter = createServer((_request, response) => {
    response.writeHead(200).end("not the version");
  });
  await new Promise<void>((resolve) =>
    squatter.listen(PROBE_PORT, "127.0.0.1", resolve),
  );
  t.after(() => new Promise((resolve) => squatter.close(resolve)));

  const dir = versionDir(
    t,
    'process.stderr.write("boom\\n");\nprocess.exit(1);\n',
  );
  const result = await probe(dir, {}, 3000);
  assert.equal(result.ok, false, result.log);
  assert.match(result.log, /the probe port was already answering/u);
});
