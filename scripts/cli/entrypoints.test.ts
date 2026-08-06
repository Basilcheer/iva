import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type CliFixture = {
  fakeBin: string;
  home: string;
  project: string;
  systemctlLog: string;
};

async function createCliFixture(t: TestContext): Promise<CliFixture> {
  const dir = await mkdtemp(join(tmpdir(), "iva-cli-entrypoints-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = join(dir, "iva");
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  const systemctlLog = join(dir, "systemctl.log");
  await mkdir(join(project, "bin"), { recursive: true });
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await copyFile(join(ROOT, "bin/iva.mjs"), join(project, "bin/iva.mjs"));
  await cp(join(ROOT, "scripts/cli"), join(project, "scripts/cli"), {
    recursive: true,
  });
  await symlink(join(ROOT, "scripts/lib"), join(project, "scripts/lib"), "dir");
  await symlink(join(ROOT, "deploy"), join(project, "deploy"), "dir");

  const fakeSystemctl = join(fakeBin, "systemctl");
  await writeFile(
    fakeSystemctl,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}`,
      'if [ "$2" = "is-active" ]; then',
      "  printf 'active\\n'",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(fakeSystemctl, 0o755);

  return { fakeBin, home, project, systemctlLog };
}

function runCli({ fakeBin, home, project }: CliFixture, args: string[]) {
  return spawnSync(process.execPath, [join(project, "bin/iva.mjs"), ...args], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_LANGUAGE: "en",
      HOME: home,
      NO_COLOR: "1",
      PATH: `${fakeBin}:/usr/bin:/bin`,
      TERM: "dumb",
    },
  });
}

void test("update rejects a fresh lock without mutating update state", async (t) => {
  const fixture = await createCliFixture(t);
  const envPath = join(fixture.project, ".env");
  const envText = "AGENT_LANGUAGE=en\nASSISTANT_DATA_DIR=data\n";
  const dataDir = join(fixture.project, "data");
  const lockDir = join(dataDir, "update.lock");
  const ownerPath = join(lockDir, "owner.json");
  const ownerText = `${JSON.stringify({
    owner: "existing-update",
    pid: 4242,
    startedAt: new Date().toISOString(),
  })}\n`;
  await mkdir(lockDir, { recursive: true });
  await writeFile(envPath, envText);
  await writeFile(ownerPath, ownerText);

  const result = runCli(fixture, ["update"]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stdout, "⚠️ An update is already running\n");
  assert.equal(result.stderr, "");
  assert.equal(await readFile(envPath, "utf8"), envText);
  assert.equal(await readFile(ownerPath, "utf8"), ownerText);
  assert.deepEqual(await readdir(dataDir), ["update.lock"]);
  assert.equal(existsSync(fixture.systemctlLog), false);
});

void test("config --recover restores the snapshot and restarts generated units", async (t) => {
  const fixture = await createCliFixture(t);
  const envPath = join(fixture.project, ".env");
  const journalPath = `${envPath}.iva-config-transaction`;
  const currentText = "MODEL_PROVIDER=codex\nIVA_PORT=9999\n";
  const oldText = "MODEL_PROVIDER=codex\nIVA_PORT=9123\n";
  await writeFile(envPath, currentText);
  await writeFile(
    journalPath,
    `${JSON.stringify({
      version: 1,
      existed: true,
      oldText,
      sha256: createHash("sha256").update(oldText).digest("hex"),
    })}\n`,
  );

  const result = runCli(fixture, ["config", "--recover"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    result.stdout,
    "✓ Recovered the previous configuration and restarted services\n",
  );
  assert.equal(result.stderr, "");
  assert.equal(await readFile(envPath, "utf8"), oldText);
  assert.equal(existsSync(journalPath), false);
  assert.deepEqual(
    (await readFile(fixture.systemctlLog, "utf8")).trim().split("\n"),
    [
      "--user daemon-reload",
      "--user restart iva.service",
      "--user is-active iva.service",
      "--user restart iva-telegram-poll.service",
      "--user is-active iva-telegram-poll.service",
    ],
  );

  const unit = await readFile(
    join(fixture.home, ".config/systemd/user/iva.service"),
    "utf8",
  );
  const canonicalProject = await realpath(fixture.project);
  assert.equal(unit.match(/^WorkingDirectory=(.*)$/m)?.[1], canonicalProject);
  assert.equal(
    unit.match(/^EnvironmentFile=(.*)$/m)?.[1],
    join(canonicalProject, ".env"),
  );
});
