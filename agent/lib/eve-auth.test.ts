/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { routeAuth } from "eve/channels/auth";
import fc from "fast-check";
import { assistantBearerAuth, createEveAuth, TURN_KINDS } from "./eve-auth.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);

const TOKEN = randomBytes(32).toString("base64url");
const request = (host: string, token?: string) =>
  new Request(`http://${host}/eve/v1/session`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

test("bearer auth accepts only the configured secret", async () => {
  const auth = assistantBearerAuth(TOKEN);
  assert.equal(await auth(request("evil.example")), null);
  assert.equal(await auth(request("evil.example", "wrong")), null);
  assert.deepEqual(await auth(request("evil.example", TOKEN)), {
    attributes: {},
    authenticator: "iva-bearer",
    principalId: "iva-internal-client",
    principalType: "service",
  });
});

const turnRequest = (token: string, turn: string) =>
  new Request("http://127.0.0.1:8723/eve/v1/session", {
    headers: { authorization: `Bearer ${token}`, "x-iva-turn": turn },
  });

test("a turn names its kind: the bearer puts each of the six kinds into the iva_turn attribute", async () => {
  const auth = assistantBearerAuth(TOKEN);
  for (const turn of [
    "watch",
    "brief",
    "insight",
    "reminder",
    "signal",
    "alert",
  ]) {
    assert.deepEqual(await auth(turnRequest(TOKEN, turn)), {
      attributes: { iva_turn: turn },
      authenticator: "iva-bearer",
      principalId: "iva-internal-client",
      principalType: "service",
    });
  }
});

test("a wrong bearer with a valid kind is still refused", async () => {
  const auth = assistantBearerAuth(TOKEN);
  assert.equal(await auth(turnRequest("wrong", "insight")), null);
  assert.equal(await auth(turnRequest("", "watch")), null);
});

test(`a kind outside the list gets no attribute (PBT, seed ${SEED})`, async () => {
  const auth = assistantBearerAuth(TOKEN);
  const kinds = [...TURN_KINDS];
  const header = fc.oneof(
    fc.string(),
    fc.constantFrom(...kinds).map((kind) => kind.toUpperCase()),
    fc.constantFrom(...kinds).map((kind) => ` ${kind}`),
    fc.constantFrom(...kinds).map((kind) => `${kind}, ${kind}`),
    fc.constantFrom(...kinds).map((kind) => `${kind},alert`),
    fc.constant("__proto__"),
    fc.constant("constructor"),
  );
  await fc.assert(
    fc.asyncProperty(header, async (turn) => {
      let request: Request;
      try {
        request = turnRequest(TOKEN, turn);
      } catch {
        return; // строку, которая не годится в заголовок, Headers не пропустит и так
      }
      const sent = request.headers.get("x-iva-turn") ?? "";
      const result = await auth(request);
      assert.ok(result);
      if (TURN_KINDS.has(sent))
        assert.deepEqual(result.attributes, { iva_turn: sent });
      else assert.deepEqual(result.attributes, {});
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test("two values of the header, as fetch joins them, are not a kind", async () => {
  const auth = assistantBearerAuth(TOKEN);
  const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
  headers.append("x-iva-turn", "watch");
  headers.append("x-iva-turn", "brief");
  const result = await auth(
    new Request("http://127.0.0.1:8723/eve/v1/session", { headers }),
  );
  assert.deepEqual(result?.attributes, {});
});

test("production auth rejects a spoofed loopback Host without a bearer", async () => {
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN }),
  );
  assert.ok(result instanceof Response);
  assert.equal(result.status, 401);
});

/** Makes the process the dev server eve 0.30's localDev() looks for, then restores it. */
const runningEveDev = (t: TestContext): void => {
  const previous = process.env.EVE_DEV;
  process.env.EVE_DEV = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.EVE_DEV;
    else process.env.EVE_DEV = previous;
  });
};

test("eve dev keeps localDev auth explicitly", async (t) => {
  runningEveDev(t);
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN, EVE_DEV: "1" }),
  );
  assert.ok(!(result instanceof Response));
  assert.equal(result.authenticator, "local-dev");
});

test("our own gate drops localDev even on a dev-server process", async (t) => {
  runningEveDev(t);
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN }),
  );
  assert.ok(result instanceof Response);
  assert.equal(result.status, 401);
});
