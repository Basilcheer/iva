/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-update-flow-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_BOT_TOKEN = "token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";

const { handleUpdateCallback, removeStaleUpdateJobs } = (await import(
  `./update-flow.ts?characterize=${Date.now()}`
)) as {
  handleUpdateCallback: (query: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  }) => Promise<true>;
  removeStaleUpdateJobs: () => Promise<void>;
};

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

type MockFetch = (
  url: string,
  init: { body?: string },
) => Promise<{ json(): Promise<{ ok: boolean; result: object }> }>;
const mutableGlobal: { fetch: MockFetch } = globalThis;

test("saved update view explains a preserved change set with no conflicts", async (t) => {
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const bundle = "2026-08-07T00-00-00-000Z-deadbeef1234";
  const bundleDir = join(dataDir, "update-conflicts", bundle);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(bundleDir, "report.json"),
    JSON.stringify({ schema: "iva-update-conflicts/v1", conflicts: [] }),
  );
  const calls: { method: string | undefined; body: Record<string, unknown> }[] =
    [];
  const previousFetch = mutableGlobal.fetch;
  mutableGlobal.fetch = async (url, init) => {
    calls.push({
      method: url.split("/").at(-1),
      body: JSON.parse(init.body ?? "{}"),
    });
    return { json: async () => ({ ok: true, result: {} }) };
  };
  try {
    await handleUpdateCallback({
      id: "callback",
      from: { id: 42 },
      message: { chat: { id: 1 }, message_id: 10 },
      data: `iva_update:conflicts:${bundle}`,
    });
  } finally {
    mutableGlobal.fetch = previousFetch;
  }

  const edit = calls.find((call) => call.method === "editMessageText");
  assert.match(String(edit?.body.text ?? ""), /saved in full/i);
  assert.doesNotMatch(String(edit?.body.text ?? ""), /Saved local conflicts:/);
});
