import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// Registers the resolve hook that lets `await import()` follow the "./x.js" specifiers
// agent/schedules/*.ts use (eve build rewrites them in production) — must come first.
import "../../scripts/lib/ts-esm-hooks.ts";
import {
  SCHEDULE_CRON,
  type ScheduleName,
  scheduleTimeOfDay,
} from "./schedule-table.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TABLE_FILE = "agent/lib/schedule-table.ts";
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".mjs"]);
const NAMES = Object.keys(SCHEDULE_CRON) as ScheduleName[];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, directory))) {
    const relative = join(directory, entry);
    if (statSync(join(REPO_ROOT, relative)).isDirectory()) {
      found.push(...sourceFiles(relative));
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry))) continue;
    if (entry.endsWith(".test.ts")) continue; // a test may state the values it expects
    found.push(relative);
  }
  return found;
}

function temporaryDataDir(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "iva-schedule-table-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

void test("the table pins the cron expressions Iva ships with", () => {
  assert.deepEqual(
    { ...SCHEDULE_CRON },
    {
      "memory-daily": "0 4 * * *",
      "memory-weekly": "15 4 * * 1",
      "memory-monthly": "20 4 1 * *",
      "memory-yearly": "25 4 1 1 *",
      digest: "0 8 * * *",
    },
  );
});

void test("scheduleTimeOfDay reads the wall-clock point off the cron string", () => {
  assert.deepEqual(NAMES.map(scheduleTimeOfDay), [
    { hour: 4, minute: 0 },
    { hour: 4, minute: 15 },
    { hour: 4, minute: 20 },
    { hour: 4, minute: 25 },
    { hour: 8, minute: 0 },
  ]);
});

void test("every schedule file takes its cron from the table", async () => {
  const files = readdirSync(join(REPO_ROOT, "agent/schedules"))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => entry.replace(/\.ts$/, ""))
    .sort();
  assert.deepEqual(files, [...NAMES].sort());

  for (const name of NAMES) {
    const module = (await import(`../schedules/${name}.ts`)) as {
      readonly default: { readonly cron: string };
    };
    assert.equal(module.default.cron, SCHEDULE_CRON[name]);
  }
});

void test("the ⏰ menu screen renders the table verbatim, in table order", async (t) => {
  const dataDir = temporaryDataDir(t);
  writeFileSync(join(dataDir, "rollup-status.json"), "{}");
  const screen = (await import("../../scripts/lib/menu/crons.ts")) as {
    readonly default: {
      readonly render: (
        state: { page: number },
        ctx: {
          deps: { dataDir: string };
          tr: (english: string, russian: string) => string;
          btn: (text: string, callbackData: string) => unknown;
          backRow: (screen: string) => unknown[];
        },
      ) => Promise<{ text: string }>;
    };
  };
  const { text } = await screen.default.render(
    { page: 0 },
    {
      deps: { dataDir },
      tr: (english: string) => english,
      btn: (text: string, callbackData: string) => ({ text, callbackData }),
      backRow: () => [],
    },
  );

  let cursor = -1;
  for (const name of NAMES) {
    const at = text.indexOf(`• ${name} (${SCHEDULE_CRON[name]}) →`);
    assert.ok(at > cursor, `menu is missing or misorders ${name}`);
    cursor = at;
  }
});

void test("no cron expression survives outside the table", () => {
  const offenders: string[] = [];
  for (const file of [...sourceFiles("agent"), ...sourceFiles("scripts")]) {
    if (file === TABLE_FILE) continue;
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const cron of Object.values(SCHEDULE_CRON)) {
      if (source.includes(cron)) offenders.push(`${file}: ${cron}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `cron expressions belong only in ${TABLE_FILE}`,
  );
});
