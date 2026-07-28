import { strict as assert } from "node:assert";
import test from "node:test";
import { routeAuth } from "eve/channels/auth";
import { assistantBearerAuth, createEveAuth } from "./eve-auth.ts";

const TOKEN = "test-token";
const request = (host, token) =>
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

test("production auth rejects a spoofed loopback Host without a bearer", async () => {
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN }),
  );
  assert.ok(result instanceof Response);
  assert.equal(result.status, 401);
});

test("eve dev keeps localDev auth explicitly", async () => {
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN, EVE_DEV: "1" }),
  );
  assert.ok(!(result instanceof Response));
  assert.equal(result.authenticator, "local-dev");
});
