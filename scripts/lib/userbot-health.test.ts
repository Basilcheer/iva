import assert from "node:assert/strict";
import test from "node:test";

import {
  probeUserbotHealth,
  USERBOT_HEALTH_TIMEOUT_MS,
} from "./userbot-health.ts";

const activeSystemd = (args: string[]) => {
  if (args[0] === "is-active")
    return Promise.resolve({ code: 0, out: "active" });
  return Promise.resolve({ code: 0, out: "enabled" });
};

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: () => Promise.resolve(body),
});

void test("userbot health uses the required 1.5 second production budget", () => {
  assert.equal(USERBOT_HEALTH_TIMEOUT_MS, 1500);
});

void test("userbot health reports off and does not contact the proxy", async () => {
  let fetched = false;
  const health = await probeUserbotHealth({
    runSystemctl: (args) =>
      Promise.resolve(
        args[0] === "is-active"
          ? { code: 3, out: "inactive" }
          : { code: 1, out: "disabled" },
      ),
    readToken: () => Promise.resolve("unused"),
    fetchImpl: () => {
      fetched = true;
      return Promise.reject(new Error("must not fetch"));
    },
  });

  assert.equal(health.state, "off");
  assert.equal(fetched, false);
});

void test("userbot health reports starting for an enabled inactive service", async () => {
  let fetched = false;
  const health = await probeUserbotHealth({
    runSystemctl: (args) =>
      Promise.resolve(
        args[0] === "is-active"
          ? { code: 3, out: "activating" }
          : { code: 0, out: "enabled" },
      ),
    readToken: () => Promise.resolve("unused"),
    fetchImpl: () => {
      fetched = true;
      return Promise.reject(new Error("must not fetch"));
    },
  });

  assert.equal(health.state, "starting");
  assert.equal(fetched, false);
});

void test("userbot health reports unreachable when the proxy is down", async () => {
  const health = await probeUserbotHealth({
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve("local-token"),
    fetchImpl: () =>
      Promise.reject(new Error("connect ECONNREFUSED secret-local-token")),
  });

  assert.deepEqual(health, {
    state: "unreachable",
    reason: "proxy_unreachable",
  });
  assert.doesNotMatch(JSON.stringify(health), /local-token|ECONNREFUSED/);
});

void test("userbot health reports unreachable on bearer mismatch and redacts the token", async () => {
  const token = "bearer-mismatch-secret";
  let authorization = "";
  const health = await probeUserbotHealth({
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve(token),
    fetchImpl: (_url, init) => {
      authorization = init.headers.authorization;
      return Promise.resolve(
        response(401, { error: "unauthorized", reflected: token }),
      );
    },
  });

  assert.equal(authorization, `Bearer ${token}`);
  assert.deepEqual(health, {
    state: "unreachable",
    reason: "proxy_auth_rejected",
  });
  assert.doesNotMatch(JSON.stringify(health), new RegExp(token));
});

void test("userbot health bounds a hanging proxy probe to its timeout", async () => {
  const started = Date.now();
  const health = await probeUserbotHealth({
    timeoutMs: 25,
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve("local-token"),
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error(String(signal.reason)),
            ),
          { once: true },
        );
      }),
  });

  assert.deepEqual(health, { state: "unreachable", reason: "probe_timeout" });
  assert.ok(
    Date.now() - started < 250,
    "probe exceeded the bounded test budget",
  );
});

void test("userbot health distinguishes an unauthorized Telethon session", async () => {
  const health = await probeUserbotHealth({
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve("local-token"),
    fetchImpl: () => Promise.resolve(response(200, { state: "unauthorized" })),
  });

  assert.deepEqual(health, {
    state: "unauthorized",
    reason: "telegram_login_required",
  });
});

void test("userbot health reports ready from the existing proxy session", async () => {
  const health = await probeUserbotHealth({
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve("local-token"),
    fetchImpl: () => Promise.resolve(response(200, { state: "ready" })),
  });

  assert.deepEqual(health, { state: "ready", reason: "ok" });
});
