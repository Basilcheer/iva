/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { probeEveHealth } from "./eve-health.ts";

const URL_OK = "http://127.0.0.1:8723/eve/v1/health";

const clock = (): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} => {
  let time = 0;
  return {
    now: () => time,
    sleep: (ms: number) => {
      time += ms;
      return Promise.resolve();
    },
  };
};

test("a non-loopback host or a foreign route is refused before any request", async () => {
  let called = false;
  const fetchFn = (() => {
    called = true;
    return Promise.resolve(new Response("", { status: 200 }));
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => probeEveHealth("http://example.com/eve/v1/health", { fetchFn }),
    /local \/eve\/v1\/health route/,
  );
  await assert.rejects(
    () => probeEveHealth("http://127.0.0.1:8723/health", { fetchFn }),
    /local \/eve\/v1\/health route/,
  );
  assert.equal(called, false);
});

test("a listener that comes up late still resolves", async () => {
  let attempts = 0;
  const fetchFn = (() => {
    attempts += 1;
    return attempts < 3
      ? Promise.reject(new Error("ECONNREFUSED"))
      : Promise.resolve(new Response("", { status: 200 }));
  }) as unknown as typeof fetch;
  await probeEveHealth(URL_OK, { fetchFn, ...clock() });
  assert.equal(attempts, 3);
});

test("the deadline reports the last status seen, or the timeout", async () => {
  const serving500 = (() =>
    Promise.resolve(
      new Response("", { status: 500 }),
    )) as unknown as typeof fetch;
  await assert.rejects(
    () => probeEveHealth(URL_OK, { fetchFn: serving500, ...clock() }),
    /local Eve health returned 500/,
  );
  const refusing = (() =>
    Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
  await assert.rejects(
    () => probeEveHealth(URL_OK, { fetchFn: refusing, ...clock() }),
    (error: unknown) =>
      (error as { code?: string }).code === "EHEALTH" &&
      /timed out/.test((error as Error).message),
  );
});
