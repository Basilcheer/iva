import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import {
  decideTelegramStartup,
  parseBacklogDropMarker,
  prepareTelegramStartup,
} from "./startup-state.ts";

const SEED = 18_702;

async function temporaryMarker(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "iva-startup-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "telegram-backlog-drop.json");
}

void test("first run publishes its marker before permitting one backlog drop", async (t) => {
  const markerFile = await temporaryMarker(t);
  const events: string[] = [];
  const first = await prepareTelegramStartup({
    markerFile,
    loadOffsetImpl: () => Promise.resolve({ offset: null, delivered: null }),
    createMarkerImpl: async (file, data) => {
      events.push("marker");
      await writeFile(file, data, { mode: 0o600, flag: "wx" });
    },
  });
  events.push("drop-permitted");

  assert.deepEqual(first, { firstRun: true, offset: null, delivered: null });
  assert.deepEqual(events, ["marker", "drop-permitted"]);
  assert.deepEqual(parseBacklogDropMarker(await readFile(markerFile, "utf8")), {
    schema: "iva-telegram-backlog-drop/v1",
  });

  await assert.rejects(
    prepareTelegramStartup({
      markerFile,
      loadOffsetImpl: () => Promise.resolve({ offset: null, delivered: null }),
      createMarkerImpl: () => assert.fail("must not replace the marker"),
    }),
    /marker exists without an offset/u,
  );
});

void test("an existing offset upgrades by writing a private marker without dropping", async (t) => {
  const markerFile = await temporaryMarker(t);
  const state = await prepareTelegramStartup({
    markerFile,
    loadOffsetImpl: () => Promise.resolve({ offset: 42, delivered: 41 }),
  });

  assert.deepEqual(state, { firstRun: false, offset: 42, delivered: 41 });
  assert.equal((await stat(markerFile)).mode & 0o777, 0o600);
});

void test("corrupt and invalid-UTF-8 marker bytes fail closed and remain unchanged", async (t) => {
  for (const bytes of [
    Buffer.from('{"schema":"wrong"}'),
    Buffer.from([0xff]),
  ]) {
    const markerFile = await temporaryMarker(t);
    await writeFile(markerFile, bytes);
    await assert.rejects(
      prepareTelegramStartup({
        markerFile,
        loadOffsetImpl: () =>
          Promise.resolve({ offset: null, delivered: null }),
      }),
      /failed to load Telegram backlog marker/u,
    );
    assert.deepEqual(await readFile(markerFile), bytes);
  }
});

void test("property: startup decision is total and fail-closed", () => {
  fc.assert(
    fc.property(
      fc.option(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), {
        nil: null,
      }),
      fc.option(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), {
        nil: null,
      }),
      fc.boolean(),
      (offset, delivered, markerPresent) => {
        const normalizedDelivered = offset === null ? null : delivered;
        const decision = decideTelegramStartup(
          { offset, delivered: normalizedDelivered },
          markerPresent ? "present" : "missing",
        );
        if (offset === null && markerPresent) {
          assert.equal(decision.action, "ambiguous");
          return;
        }
        if (offset === null) {
          assert.equal(decision.action, "write-marker-and-drop");
          return;
        }
        assert.equal(
          decision.action,
          markerPresent ? "resume" : "write-marker-and-resume",
        );
        assert.equal(decision.offset, offset);
        assert.equal(decision.delivered, normalizedDelivered);
      },
    ),
    { seed: SEED, numRuns: 2_000 },
  );
});
