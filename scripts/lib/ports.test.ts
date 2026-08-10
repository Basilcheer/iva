import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  bindProbe,
  confirmOccupiedCurrentPort,
  PortChecker,
  PortSelector,
} from "./ports.ts";

void test("the selector steps over a port something is already listening on", async (t) => {
  // Ephemeral, so two test files running at once never squat the same number.
  // On the wildcard address, which is the one the bind probe asks the kernel about:
  // BSD lets a wildcard bind sit beside a loopback one, so a listener on 127.0.0.1
  // alone is invisible to it - and that is the race the probe port retry is for.
  const held = net.createServer();
  const taken = await new Promise<number>((resolve) =>
    held.listen(0, "0.0.0.0", () =>
      resolve((held.address() as net.AddressInfo).port),
    ),
  );
  t.after(() => new Promise((resolve) => held.close(() => resolve(undefined))));

  const free = await new PortSelector(new PortChecker([bindProbe])).firstFree(
    taken,
  );
  assert.notEqual(free, taken);
  assert.ok(free !== null && free > taken, `got ${String(free)}`);
});

void test("an occupied current port is never assumed to belong to Iva", async () => {
  const prompts: Array<{ port: number; holders: string[] }> = [];
  assert.equal(
    await confirmOccupiedCurrentPort({
      port: 8723,
      currentPort: 8723,
      // eslint-disable-next-line @typescript-eslint/require-await
      confirm: async (details) => {
        prompts.push(details);
        return false;
      },
      holders: ["bind: port occupied", "docker:foreign"],
    }),
    false,
  );
  assert.deepEqual(prompts, [
    {
      port: 8723,
      holders: ["bind: port occupied", "docker:foreign"],
    },
  ]);
});
void test("the current occupied port is reused only after explicit confirmation", async () => {
  assert.equal(
    await confirmOccupiedCurrentPort({
      port: 8723,
      currentPort: 8723,
      // eslint-disable-next-line @typescript-eslint/require-await
      confirm: async () => true,
    }),
    true,
  );
  assert.equal(
    await confirmOccupiedCurrentPort({
      port: 9000,
      currentPort: 8723,
      // eslint-disable-next-line @typescript-eslint/require-await
      confirm: async () => {
        throw new Error("must not ask for a different port");
      },
    }),
    false,
  );
});
