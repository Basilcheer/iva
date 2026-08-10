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
import { runScheduleMigration } from "../../scripts/lib/schedule-migration.ts";
import {
  SCHEDULE_CRON,
  type ScheduleName,
  scheduleCron,
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

// Also the guard on the table itself: a future entry with a list, range, step or two day
// constraints at once makes scheduleCron throw, and it throws here, at desk time.
void test("scheduleCron reads every entry off its cron string", () => {
  assert.deepEqual(NAMES.map(scheduleCron), [
    { minute: 0, hour: 4, dayOfMonth: null, month: null, dayOfWeek: null },
    { minute: 15, hour: 4, dayOfMonth: null, month: null, dayOfWeek: 1 },
    { minute: 20, hour: 4, dayOfMonth: 1, month: null, dayOfWeek: null },
    { minute: 25, hour: 4, dayOfMonth: 1, month: 1, dayOfWeek: null },
    { minute: 0, hour: 8, dayOfMonth: null, month: null, dayOfWeek: null },
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

// The catch-up consumer never exposes the due point it computes; it only decides whether a
// period runs, and it runs one exactly when the recorded success predates that point. So
// bisect on that boundary through the public entry point and check the instant it converges
// on against the cron the table names. A day constraint restated inside the migration — a
// hardcoded Monday, a hardcoded 1st — instead of read from the table fails here.
type Period = "daily" | "weekly" | "monthly" | "yearly";
const PERIODS: readonly Period[] = ["daily", "weekly", "monthly", "yearly"];
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Probing instant: 6h after a date the cron matches — inside every grace window the
// migration keeps (20h at the narrowest), so a cadence change in the table moves the probe
// with it instead of stranding it. The bisection window then only has to reach past 6h.
const PROBE_AGE_MS = 6 * HOUR_MS;
const PROBE_WINDOW_MS = 12 * HOUR_MS;

function probeNow(cron: ReturnType<typeof scheduleCron>): number {
  // August 4th 2026 stands in for whatever the cron leaves unconstrained.
  let date = Date.UTC(2026, (cron.month ?? 8) - 1, cron.dayOfMonth ?? 4);
  if (cron.dayOfWeek !== null)
    date += ((cron.dayOfWeek - new Date(date).getUTCDay() + 7) % 7) * DAY_MS;
  return date + cron.hour * HOUR_MS + cron.minute * MINUTE_MS + PROBE_AGE_MS;
}

async function catchUpRuns(
  statusPath: string,
  period: Period,
  lastSuccessAt: number,
  now: number,
): Promise<boolean> {
  const status: Record<string, { lastSuccessAt: number }> = {};
  for (const other of PERIODS) {
    // Every other period is recorded as succeeding at `now`, so only the one under test
    // can come out due — and none of them gets seeded, which would skip it either way.
    status[`memory-${other}`] = {
      lastSuccessAt: other === period ? lastSuccessAt : now,
    };
  }
  writeFileSync(statusPath, JSON.stringify(status));
  const ran: Period[] = [];
  await runScheduleMigration({
    statusPath,
    tz: "UTC",
    now: () => now,
    log: () => {},
    runJob: (fired) => {
      ran.push(fired);
      return Promise.resolve();
    },
  });
  return ran.includes(period);
}

void test("the migration catches a period up at the point the table's cron names", async (t) => {
  const statusPath = join(temporaryDataDir(t), "rollup-status.json");
  for (const period of PERIODS) {
    const cron = scheduleCron(`memory-${period}`);
    const now = probeNow(cron);
    // Invariant of the bisection: `runs` is a baseline old enough to be caught up,
    // `suppressed` is one recent enough not to be — the due point sits between them.
    let runs = now - PROBE_WINDOW_MS;
    let suppressed = now;
    assert.ok(
      await catchUpRuns(statusPath, period, runs, now),
      `${period}: nothing was caught up 6h after the table says it fires`,
    );
    assert.ok(
      !(await catchUpRuns(statusPath, period, suppressed, now)),
      `${period}: a success recorded at "now" must leave nothing to catch up`,
    );
    while (suppressed - runs > 1) {
      const mid = Math.floor((runs + suppressed) / 2);
      if (await catchUpRuns(statusPath, period, mid, now)) runs = mid;
      else suppressed = mid;
    }

    // The oldest success that still suppresses the catch-up IS the due point.
    const dueAt = new Date(suppressed);
    assert.equal(
      dueAt.getUTCSeconds(),
      0,
      `${period}: due point is not on a minute`,
    );
    assert.equal(dueAt.getUTCMinutes(), cron.minute, `${period}: due minute`);
    assert.equal(dueAt.getUTCHours(), cron.hour, `${period}: due hour`);
    if (cron.dayOfWeek !== null)
      assert.equal(dueAt.getUTCDay(), cron.dayOfWeek, `${period}: due weekday`);
    if (cron.dayOfMonth !== null)
      assert.equal(
        dueAt.getUTCDate(),
        cron.dayOfMonth,
        `${period}: due day of month`,
      );
    if (cron.month !== null)
      assert.equal(dueAt.getUTCMonth() + 1, cron.month, `${period}: due month`);
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
