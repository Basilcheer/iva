/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Расписание тика proactive (agent/schedules/proactive.ts) отдаёт ребёнку срок «работу
// кончить» за 90 с до SIGTERM, как у ночи: тик успевает отменить ход Insight на сервере и снять
// замок. Тест лежит в agent/lib: eve считает расписанием каждый файл в agent/schedules (см.
// trace-hook.test.ts). Расписание запускается настоящим раннером, но в пустом корне, где
// scripts/proactive/tick.ts — подставной ребёнок, который только записывает свой срок.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "../../scripts/lib/ts-esm-hooks.ts";
import { JOB_STOP_AT_ENV, JOB_STOP_GRACE_MS } from "./schedule-runner.ts";

const MIN = 60_000;

test("the proactive tick gets IVA_JOB_STOP_AT 90 s before its SIGTERM at 30 minutes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-proactive-schedule-"));
  const data = join(root, "data");
  mkdirSync(join(root, "scripts/proactive"), { recursive: true });
  mkdirSync(data);
  writeFileSync(
    join(root, "scripts/proactive/tick.ts"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(data, "stop-at"))}, String(process.env.${JOB_STOP_AT_ENV}));
`,
  );
  const cwd = process.cwd();
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.chdir(root);
  process.env.ASSISTANT_DATA_DIR = data;
  t.after(() => {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);

  const schedule = (await import("../schedules/proactive.ts")).default as {
    run(context: { waitUntil(work: Promise<unknown>): void }): void;
  };
  const before = Date.now();
  let work: Promise<unknown> = Promise.resolve();
  schedule.run({
    waitUntil: (promise) => {
      work = promise;
    },
  });
  await work;
  const after = Date.now();

  const stopAt = Number(readFileSync(join(data, "stop-at"), "utf8"));
  const lead = 30 * MIN - JOB_STOP_GRACE_MS;
  assert.equal(JOB_STOP_GRACE_MS, 90_000);
  assert.ok(
    stopAt >= before + lead && stopAt <= after + lead,
    `stop at ${stopAt - before} ms after the start, expected ${lead}`,
  );
});
