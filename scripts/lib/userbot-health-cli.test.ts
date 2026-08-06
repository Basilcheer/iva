import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type RunOptions = SpawnOptions & { readonly encoding?: BufferEncoding };

type RunResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    (child.stdout as NonNullable<typeof child.stdout>).on(
      "data",
      (chunk: string) => {
        stdout += chunk;
      },
    );
    (child.stderr as NonNullable<typeof child.stderr>).on(
      "data",
      (chunk: string) => {
        stderr += chunk;
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

void test("iva userbot diagnose --json returns the shared ready state without secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-userbot-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, "iva");
  const fakeBin = join(dir, "bin");
  const token = "diagnose-secret-token";
  await mkdir(join(project, "bin"), { recursive: true });
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(join(project, "data"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await copyFile(join(ROOT, "bin/iva.mjs"), join(project, "bin/iva.mjs"));
  await cp(join(ROOT, "scripts/cli"), join(project, "scripts/cli"), {
    recursive: true,
  });
  await symlink(join(ROOT, "scripts/lib"), join(project, "scripts/lib"), "dir");
  await writeFile(join(project, "data/telegram-userbot.token"), token);

  const systemctl = join(fakeBin, "systemctl");
  await writeFile(
    systemctl,
    [
      "#!/bin/sh",
      'if [ "$2" = "is-active" ]; then echo active; exit 0; fi',
      'if [ "$2" = "is-enabled" ]; then echo enabled; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
  );
  await chmod(systemctl, 0o755);

  const server = createServer((request, response) => {
    assert.equal(request.url, "/healthz");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"state":"ready"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  await writeFile(join(project, ".env"), `TELEGRAM_MCP_PORT=${port}\n`);

  const result = await run(
    process.execPath,
    [join(project, "bin/iva.mjs"), "userbot", "diagnose", "--json"],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: join(dir, "home"),
        NO_COLOR: "1",
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { state: "ready", reason: "ok" });
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(token));
});
