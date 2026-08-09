/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appliedMigrations, runMigrations } from "./migrations.ts";

type Fixture = {
  dir: string;
  dataDir: string;
  log: string;
  write(name: string, body: string): void;
  run(): Promise<string[]>;
  entries(): string[];
};

function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "iva-migrations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "migrations");
  const dataDir = join(root, "data");
  const log = join(root, "applied.log");
  mkdirSync(dir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    dir,
    dataDir,
    log,
    write: (name, body) => writeFileSync(join(dir, name), body),
    run: () => runMigrations({ dir, dataDir, context: { dataDir, log } }),
    entries: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").split("\n").filter(Boolean)
        : [],
  };
}

/** A migration body that records one line per execution. */
function recorder(tag: string, extra = ""): string {
  return (
    `import { appendFileSync } from "node:fs";\n` +
    `export default function up(context) {\n` +
    `  appendFileSync(context.log, ${JSON.stringify(tag)} + "\\n");\n` +
    `${extra}}\n`
  );
}

test("migrations run once, in order, and record what was applied", async (t) => {
  const migrations = fixture(t);
  migrations.write("002-second.ts", recorder("second"));
  migrations.write("001-first.ts", recorder("first"));
  migrations.write("010-tenth.ts", recorder("tenth"));
  // Everything that is not a numbered migration is ignored.
  migrations.write("README.md", "not a migration\n");
  migrations.write("001-first.test.ts", recorder("test-file"));
  migrations.write("no-number.ts", recorder("unnumbered"));

  assert.deepEqual(await migrations.run(), [
    "001-first",
    "002-second",
    "010-tenth",
  ]);
  assert.deepEqual(migrations.entries(), ["first", "second", "tenth"]);
  assert.deepEqual(appliedMigrations(migrations.dataDir), [
    "001-first",
    "002-second",
    "010-tenth",
  ]);
});

test("a second run is a no-op even when the migrations are still on disk", async (t) => {
  const migrations = fixture(t);
  migrations.write("001-first.ts", recorder("first"));
  await migrations.run();

  assert.deepEqual(await migrations.run(), []);
  assert.deepEqual(await migrations.run(), []);
  assert.deepEqual(migrations.entries(), ["first"]);
});

test("only migrations added since the last run are applied", async (t) => {
  const migrations = fixture(t);
  migrations.write("001-first.ts", recorder("first"));
  await migrations.run();
  migrations.write("002-second.ts", recorder("second"));

  assert.deepEqual(await migrations.run(), ["002-second"]);
  assert.deepEqual(migrations.entries(), ["first", "second"]);
});

test("a failing migration stops the run and keeps earlier ones recorded", async (t) => {
  const migrations = fixture(t);
  migrations.write("001-first.ts", recorder("first"));
  migrations.write(
    "002-broken.ts",
    recorder("broken", `  throw new Error("disk is full");\n`),
  );
  migrations.write("003-third.ts", recorder("third"));

  await assert.rejects(migrations.run(), /002-broken.*disk is full/s);
  assert.deepEqual(migrations.entries(), ["first", "broken"]);
  assert.deepEqual(appliedMigrations(migrations.dataDir), ["001-first"]);

  // The failure is not recorded, so the next run retries it rather than skipping ahead.
  await assert.rejects(migrations.run(), /002-broken/);
  assert.deepEqual(migrations.entries(), ["first", "broken", "broken"]);
  assert.deepEqual(appliedMigrations(migrations.dataDir), ["001-first"]);
});

test("an unreadable marker replays migrations, which must therefore be idempotent", async (t) => {
  const migrations = fixture(t);
  // The real contract: the migration itself checks the world, not the marker.
  migrations.write(
    "001-first.ts",
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `export default function up(context) {\n` +
      `  const target = join(context.dataDir, "migrated.txt");\n` +
      `  if (existsSync(target)) return;\n` +
      `  writeFileSync(target, "done");\n` +
      `  appendFileSync(context.log, "first\\n");\n` +
      `}\n`,
  );
  await migrations.run();
  writeFileSync(join(migrations.dataDir, "migrations.json"), "{not json");

  assert.deepEqual(appliedMigrations(migrations.dataDir), []);
  assert.deepEqual(await migrations.run(), ["001-first"]);
  assert.deepEqual(migrations.entries(), ["first"]);
});

test("a missing migrations directory and an unwritable marker are reported honestly", async (t) => {
  const migrations = fixture(t);
  assert.deepEqual(
    await runMigrations({
      dir: join(migrations.dir, "absent"),
      dataDir: migrations.dataDir,
      context: {},
    }),
    [],
  );

  migrations.write("001-first.ts", recorder("first"));
  appendFileSync(migrations.log, "");
  rmSync(migrations.dataDir, { recursive: true, force: true });
  writeFileSync(migrations.dataDir, "not a directory");
  await assert.rejects(migrations.run());
});
