/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import test from "node:test";
import assert from "node:assert/strict";
import type { AttachSessionFn } from "eve/channels";
import {
  handleTelegramCompactRequest,
  localCompactUrl,
  requestTelegramCompact,
} from "#lib/telegram-compact-route.ts";

type FetchCall = { url: string; init: RequestInit };

function compactHarness(
  calls: string[],
  status: "accepted" | "no_active_session" = "accepted",
): AttachSessionFn {
  return ((sessionId: string) => ({
    id: sessionId,
    compact: async () => {
      calls.push(sessionId);
      return status === "accepted" ? { sessionId, status } : { status };
    },
  })) as AttachSessionFn;
}

const request = (body: string, secret = "secret") =>
  new Request("http://local/eve/v1/telegram/compact", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body,
  });

test("compact client sends the session and webhook secret, and reports acceptance", async () => {
  const calls: FetchCall[] = [];
  const accepted = await requestTelegramCompact({
    url: "http://127.0.0.1/eve/v1/telegram/compact",
    secret: "secret",
    sessionId: "session-55",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, status: "accepted" });
    },
  });

  assert.equal(accepted, true);
  assert.equal(calls[0]?.url, "http://127.0.0.1/eve/v1/telegram/compact");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)[
      "X-Telegram-Bot-Api-Secret-Token"
    ],
    "secret",
  );
  const requestBody = calls[0]?.init.body;
  if (typeof requestBody !== "string")
    throw new Error("expected string request body");
  assert.deepEqual(JSON.parse(requestBody), { sessionId: "session-55" });
});

test("compact client reports a retired session as not accepted", async () => {
  const accepted = await requestTelegramCompact({
    url: "http://local/compact",
    secret: "secret",
    sessionId: "session-1",
    fetchImpl: async () =>
      Response.json({ ok: true, status: "no_active_session" }),
  });
  assert.equal(accepted, false);
});

test("compact client rejects HTTP failures and malformed route responses", async () => {
  const replies = [
    () => new Response("nope", { status: 500 }),
    () => Response.json({ ok: false, status: "accepted" }),
    () => Response.json({ ok: true, status: "compacted" }),
    () => Response.json(null),
  ];
  for (const reply of replies)
    await assert.rejects(
      requestTelegramCompact({
        url: "http://local/compact",
        secret: "secret",
        sessionId: "session-1",
        fetchImpl: async () => reply(),
      }),
    );
});

test("compact route compacts the exact session and returns eve's status", async () => {
  for (const status of ["accepted", "no_active_session"] as const) {
    const calls: string[] = [];
    const response = await handleTelegramCompactRequest(
      request(JSON.stringify({ sessionId: "session-9" })),
      compactHarness(calls, status),
      "secret",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status });
    assert.deepEqual(calls, ["session-9"]);
  }
});

test("compact route rejects a wrong secret and a body without a session", async () => {
  const calls: string[] = [];
  const attach = compactHarness(calls);
  const unauthorized = await handleTelegramCompactRequest(
    request(JSON.stringify({ sessionId: "session-9" }), "wrong"),
    attach,
    "secret",
  );
  assert.equal(unauthorized.status, 401);
  for (const body of ["{", "null", "{}", '{"sessionId":""}', '{"sessionId":7}'])
    assert.equal(
      (await handleTelegramCompactRequest(request(body), attach, "secret"))
        .status,
      400,
      body,
    );
  assert.deepEqual(calls, []);
});

test("the local compact URL follows the same host rule as cancel", () => {
  assert.equal(
    localCompactUrl({}),
    "http://127.0.0.1:8723/eve/v1/telegram/compact",
  );
  assert.equal(
    localCompactUrl({ ASSISTANT_HOST: "https://poll.example.test:9443/" }),
    "https://poll.example.test:9443/eve/v1/telegram/compact",
  );
  assert.equal(
    localCompactUrl({ IVA_PORT: "9001" }),
    "http://127.0.0.1:9001/eve/v1/telegram/compact",
  );
});
