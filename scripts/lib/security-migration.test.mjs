import { strict as assert } from "node:assert";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const STABLE_BEARER = "a".repeat(43);

test("old install migration deduplicates a stable bearer and writes a loopback unit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-security-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = join(dir, "iva");
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  await mkdir(join(project, "bin"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await copyFile(join(ROOT, "bin/iva.mjs"), join(project, "bin/iva.mjs"));
  await symlink(join(ROOT, "scripts"), join(project, "scripts"), "dir");
  await symlink(join(ROOT, "deploy"), join(project, "deploy"), "dir");

  const envPath = join(project, ".env");
  await writeFile(
    envPath,
    [
      "MODEL_PROVIDER=codex",
      "ASSISTANT_BEARER=",
      "IVA_PORT=9123",
      `ASSISTANT_BEARER=${STABLE_BEARER}`,
      "ASSISTANT_HOST=http://127.0.0.1:9123",
      "",
    ].join("\n"),
  );
  await chmod(envPath, 0o644);

  const fakeSystemctl = join(fakeBin, "systemctl");
  await writeFile(fakeSystemctl, "#!/bin/sh\nexit 0\n");
  await chmod(fakeSystemctl, 0o755);

  const runMigration = () =>
    spawnSync(
      process.execPath,
      [join(project, "bin/iva.mjs"), "_install-units"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          NO_COLOR: "1",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
      },
    );

  const first = runMigration();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const migrated = await readFile(envPath, "utf8");
  assert.equal(
    migrated.match(/^ASSISTANT_BEARER=/gm)?.length,
    1,
    "duplicate bearer entries are collapsed",
  );
  assert.match(
    migrated,
    new RegExp(`^ASSISTANT_BEARER=${STABLE_BEARER}$`, "m"),
  );
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);

  const unit = await readFile(
    join(home, ".config/systemd/user/iva.service"),
    "utf8",
  );
  assert.match(unit, /eve\.js start --host 127\.0\.0\.1/);

  const second = runMigration();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(
    await readFile(envPath, "utf8"),
    migrated,
    "a second migration is byte-stable",
  );
});
