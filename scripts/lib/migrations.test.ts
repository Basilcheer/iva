/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { runMigrations } from "./version-update.ts";

type Fixture = {
  dir: string;
  dataDir: string;
  log: string;
  write(name: string, body: string): void;
  run(): Promise<string[]>;
  entries(): string[];
  applied(): string[];
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
    // Read straight off the disk: the marker outlives the process that wrote it,
    // so the module's own reader must not be the one judging what it recorded.
    applied: () => {
      try {
        const marker: unknown = JSON.parse(
          readFileSync(join(dataDir, "migrations.json"), "utf8"),
        );
        return (marker as { applied: string[] }).applied;
      } catch {
        return [];
      }
    },
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
  assert.deepEqual(migrations.applied(), [
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
  assert.deepEqual(migrations.applied(), ["001-first"]);

  // The failure is not recorded, so the next run retries it rather than skipping ahead.
  await assert.rejects(migrations.run(), /002-broken/);
  assert.deepEqual(migrations.entries(), ["first", "broken", "broken"]);
  assert.deepEqual(migrations.applied(), ["001-first"]);
});

test("a malformed marker blocks migrations and stays byte-identical", async (t) => {
  const migrations = fixture(t);
  migrations.write("001-first.ts", recorder("first"));
  const marker = join(migrations.dataDir, "migrations.json");
  const corrupt = Buffer.from("{not json");
  writeFileSync(marker, corrupt);

  await assert.rejects(migrations.run(), /migrations\.json is corrupt/u);
  assert.deepEqual(migrations.entries(), []);
  assert.deepEqual(readFileSync(marker), corrupt);
});

test("a dangling migration marker blocks execution without changing its object", async (t) => {
  const migrations = fixture(t);
  migrations.write("001-first.ts", recorder("first"));
  const marker = join(migrations.dataDir, "migrations.json");
  const target = join(migrations.dataDir, "missing-migrations-target.json");
  symlinkSync(target, marker);
  const before = lstatSync(marker);

  let caught: unknown;
  try {
    await migrations.run();
  } catch (error) {
    caught = error;
  }

  assert.deepEqual(migrations.entries(), [], "migration ran before validation");
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /migrations\.json is corrupt/u);
  assert.equal(lstatSync(marker).ino, before.ino);
  assert.equal(lstatSync(marker).isSymbolicLink(), true);
  assert.equal(readlinkSync(marker), target);
  assert.equal(existsSync(target), false);
});

test("invalid UTF-8 blocks migrations before import", async (t) => {
  const migrations = fixture(t);
  migrations.write("001-first.ts", recorder("first"));
  const marker = join(migrations.dataDir, "migrations.json");
  const corrupt = Buffer.from([0xff, 0xfe, 0x7b]);
  writeFileSync(marker, corrupt);

  await assert.rejects(migrations.run(), /invalid UTF-8/u);
  assert.deepEqual(migrations.entries(), []);
  assert.deepEqual(readFileSync(marker), corrupt);
});

test("semantic-invalid migration markers fail closed", async (t) => {
  const migrations = fixture(t);
  migrations.write("001-first.ts", recorder("first"));
  const marker = join(migrations.dataDir, "migrations.json");
  const invalid = [
    {},
    { schema: "iva-migrations/v1", applied: "001-first" },
    { schema: "iva-migrations/v1", applied: ["bad-name"] },
    { schema: "iva-migrations/v1", applied: ["001-first", "001-first"] },
    { schema: "iva-migrations/v1", applied: [], extra: true },
  ];

  for (const state of invalid) {
    const bytes = Buffer.from(JSON.stringify(state));
    writeFileSync(marker, bytes);
    await assert.rejects(migrations.run(), /invalid migration state schema/u);
    assert.deepEqual(readFileSync(marker), bytes);
  }
  assert.deepEqual(migrations.entries(), []);
});

test("arbitrary malformed migration bytes fail closed with a fixed seed", async (t) => {
  const migrations = fixture(t);
  migrations.write("001-first.ts", recorder("first"));
  const marker = join(migrations.dataDir, "migrations.json");

  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 128 }), async (tail) => {
      const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(tail)]);
      writeFileSync(marker, bytes);
      await assert.rejects(migrations.run(), /migrations\.json is corrupt/u);
      assert.deepEqual(readFileSync(marker), bytes);
      assert.deepEqual(migrations.entries(), []);
    }),
    { seed: 41909, numRuns: 80 },
  );
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

test("a corrupt marker is irrelevant when the candidate ships no migration", async (t) => {
  const migrations = fixture(t);
  migrations.write("README.md", "no migration\n");
  const marker = join(migrations.dataDir, "migrations.json");
  const corrupt = Buffer.from([0xff, 0x7b]);
  writeFileSync(marker, corrupt);

  assert.deepEqual(await migrations.run(), []);
  assert.deepEqual(readFileSync(marker), corrupt);
  assert.deepEqual(migrations.entries(), []);
});

test("the migration marker uses the canonical private atomic writer", async (t) => {
  const migrations = fixture(t);
  migrations.write("001-first.ts", recorder("first"));

  await migrations.run();

  assert.equal(
    statSync(join(migrations.dataDir, "migrations.json")).mode & 0o777,
    0o600,
  );
});
