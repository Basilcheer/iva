/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  localSessionCompactUrl,
  requestSessionCompact,
} from "#lib/eve-compact.ts";

type FetchCall = { url: string; init: RequestInit };
const ask = (reply: () => Response, log: unknown[][] = []) =>
  requestSessionCompact({
    url: "http://local/eve/v1/session/s/compact",
    bearer: "token",
    fetchImpl: async () => reply(),
    logImpl: (...parts) => log.push(parts),
  });

test("the compact request goes to eve's session route with the shared bearer and an empty body", async () => {
  const calls: FetchCall[] = [];
  const accepted = await requestSessionCompact({
    url: localSessionCompactUrl("wrun_55", {}),
    bearer: "token-55",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(
        { ok: true, sessionId: "wrun_55", status: "accepted" },
        { status: 202 },
      );
    },
  });

  assert.equal(accepted, true);
  assert.equal(
    calls[0]?.url,
    "http://127.0.0.1:8723/eve/v1/session/wrun_55/compact",
  );
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer token-55",
  );
  assert.equal(calls[0]?.init.body, "{}");
});

test("a retired session is a quiet refusal", async () => {
  const log: unknown[][] = [];
  assert.equal(
    await ask(
      () => Response.json({ ok: true, status: "no_active_session" }),
      log,
    ),
    false,
  );
  assert.deepEqual(log, []);
});

test("any other answer from eve is a logged refusal, never an acceptance", async () => {
  const replies = [
    () => new Response("unauthorized", { status: 401 }),
    () =>
      Response.json(
        { ok: false, error: "Failed to compact the session." },
        { status: 500 },
      ),
    () => Response.json({ ok: true, status: "accepted" }),
    () => Response.json({ ok: true, status: "compacted" }, { status: 202 }),
    () => Response.json(null, { status: 202 }),
    () => new Response("<html>", { status: 202 }),
  ];
  for (const reply of replies) {
    const log: unknown[][] = [];
    assert.equal(await ask(reply, log), false);
    assert.equal(log.length, 1);
  }
});

test("no answer at all throws: the caller cannot tell whether eve accepted", async () => {
  await assert.rejects(
    requestSessionCompact({
      url: "http://local/compact",
      bearer: "token",
      fetchImpl: async () => {
        throw new Error("The operation was aborted due to timeout");
      },
    }),
    /timeout/u,
  );
});

test("the session id is path-encoded and the host follows the channel rule", () => {
  assert.equal(
    localSessionCompactUrl("a/b c", {
      ASSISTANT_HOST: "https://poll.example.test:9443/",
    }),
    "https://poll.example.test:9443/eve/v1/session/a%2Fb%20c/compact",
  );
  assert.equal(
    localSessionCompactUrl("s", { IVA_PORT: "9001" }),
    "http://127.0.0.1:9001/eve/v1/session/s/compact",
  );
});
