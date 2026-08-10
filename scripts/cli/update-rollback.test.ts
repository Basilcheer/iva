/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

/**
 * The one end-to-end scenario that has to wait out the health deadline after the
 * restart, which is why it is not in the serial run of `update-bridge.test.ts`:
 * a version that builds, passes the probe on scratch state and then dies on the
 * state the installation actually has.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createWorld, type World } from "../fixtures/install-world.ts";
import { createVersionStore } from "../lib/version-store.ts";

function world(t: TestContext): World {
  const created = createWorld();
  t.after(() => {
    // The service an update starts outlives it, as the real one does.
    created.stop();
    rmSync(created.dir, { recursive: true, force: true });
  });
  return created;
}

/** Whatever answers on the installation's own port, as a client would find it. */
async function answers(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return true;
    } catch {
      // Not up yet, or not coming up: the loop below decides which.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

test("a version that dies on the installation's own state is rolled back", async (t) => {
  const iva = world(t);
  const first = iva.iva(["update"]);
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  const store = createVersionStore(iva.home);
  const served = String(store.currentName());
  // The user's own cards, which no probe ever opens: a scratch data directory is
  // where the check before the flip sends the version it starts.
  writeFileSync(join(iva.home, "data/cards.md"), "# a card the user has\n");
  iva.publish((tree) =>
    writeFileSync(join(tree, "scripts/feature.mjs"), "// STATE_BREAK\n"),
  );

  const result = iva.iva(["update"]);
  const output = `${result.stdout}${result.stderr}`;

  // Not "✅ updated" over a service in a crash loop: the update fails, says on
  // which port nothing answered, and takes the installation back itself.
  assert.equal(result.status, 1, output);
  assert.match(output, new RegExp(`did not answer on port ${iva.port}`, "u"));
  assert.match(output, new RegExp(`going back to ${served}`, "u"));
  assert.equal(store.currentName(), served, output);
  // Settled there too, or the next update believes it still owes the move.
  assert.equal(store.settled(), served, output);

  // The three starts of the scenario: the probe on scratch state, the service on
  // the installation's own that died, and the older version restarted onto it.
  const starts = readFileSync(iva.startsLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { cwd: string; probe: string });
  assert.deepEqual(
    starts.slice(-2).map((start) => start.probe),
    ["", ""],
  );
  assert.equal(starts.at(-1)?.cwd, join(iva.home, "versions", served), output);
  // And it is a running agent again, not a directory the user has to fix by hand
  // through the very agent that is down.
  assert.equal(await answers(iva.port), true, output);
});
