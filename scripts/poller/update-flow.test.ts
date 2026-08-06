/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-update-flow-"));
process.env.ASSISTANT_DATA_DIR = dataDir;

const { removeStaleUpdateJobs } = (await import(
  `./update-flow.ts?characterize=${Date.now()}`
)) as { removeStaleUpdateJobs: () => Promise<void> };

test("stale update-job cleanup removes only expired JSON job files", async () => {
  const jobs = join(dataDir, "update-jobs");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(jobs));
  const oldJob = join(jobs, "old.json");
  const freshJob = join(jobs, "fresh.json");
  const other = join(jobs, "keep.txt");
  writeFileSync(oldJob, "{}");
  writeFileSync(freshJob, "{}");
  writeFileSync(other, "keep");
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(oldJob, old, old);

  await removeStaleUpdateJobs();

  await assert.doesNotReject(() =>
    import("node:fs/promises").then(({ stat }) => stat(freshJob)),
  );
  await assert.doesNotReject(() =>
    import("node:fs/promises").then(({ stat }) => stat(other)),
  );
  await assert.rejects(() =>
    import("node:fs/promises").then(({ stat }) => stat(oldJob)),
  );
});
