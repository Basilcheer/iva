/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// The Codex subscription is signed in by scripts/lib/codex-oauth.ts (`iva login` and the setup
// wizard, which both have to run on an install whose agent/ is missing) and used by
// agent/lib/codex-auth.ts (the agent refreshing the token before every model call). Neither
// half may import the other at load time, so the OAuth constants, the token file path, its
// read, its atomic 0600 write and the id_token claim reader exist on both sides. This test is
// what ties the copies: it signs in through the login half, reads the result back through the
// runtime half, and holds the protocol constants of one side against the traffic of the other.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountFromIdToken as authoredAccountFromIdToken,
  authFilePath as authoredAuthFilePath,
  CLIENT_ID as AUTHORED_CLIENT_ID,
  codexAuthHeaders,
  ISSUER as AUTHORED_ISSUER,
  ORIGINATOR as AUTHORED_ORIGINATOR,
  readAuth as authoredReadAuth,
  TOKEN_URL as AUTHORED_TOKEN_URL,
  writeAuth,
} from "#lib/codex-auth.ts";
import {
  accountFromIdToken,
  authFilePath,
  CLIENT_ID,
  ISSUER,
  ORIGINATOR,
  readAuth,
  runDeviceCodeLogin,
  TOKEN_URL,
} from "./codex-oauth.ts";

const b64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** An id_token carrying the account claim, valid far past any refresh skew. */
const idToken = (): string =>
  [
    b64url({ alg: "none" }),
    b64url({
      exp: 9_999_999_999,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acc_seam",
        chatgpt_plan_type: "pro",
      },
    }),
    "signature",
  ].join(".");

function scratchDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-codex-seam-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type CapturedRequest = { url: string; body: string };

/**
 * Drives the device-code flow against a fake OpenAI, so nothing leaves the process, and
 * hands back every request it made — that traffic is what pins the OAuth constants.
 */
async function signIn(dataDir: string): Promise<CapturedRequest[]> {
  const tokens = {
    id_token: idToken(),
    access_token: idToken(),
    refresh_token: "refresh-1",
  };
  const requests: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
    // Both flows post strings (JSON or urlencoded); anything else is not a body we pin.
    requests.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (url.endsWith("/deviceauth/usercode"))
      return Promise.resolve(
        Response.json({
          device_auth_id: "dev-1",
          user_code: "CODE-1",
          interval: 0,
        }),
      );
    if (url.endsWith("/deviceauth/token"))
      return Promise.resolve(
        Response.json({ authorization_code: "auth-1", code_verifier: "ver-1" }),
      );
    if (url.endsWith("/oauth/token"))
      return Promise.resolve(Response.json(tokens));
    throw new Error(`unexpected request: ${url}`);
  };
  try {
    await runDeviceCodeLogin({ dataDir, log: () => {} });
  } finally {
    globalThis.fetch = realFetch;
  }
  return requests;
}

test("a login writes the token file the runtime half reads back", async (t) => {
  const dataDir = scratchDir(t);
  await signIn(dataDir);

  const stored = authoredReadAuth(dataDir);
  assert.equal(stored?.accountId, "acc_seam");
  assert.equal(stored?.planType, "pro");
  assert.equal(stored?.refresh_token, "refresh-1");

  // A fresh token needs no refresh, so the headers come straight off the stored file.
  const headers = await codexAuthHeaders(dataDir);
  assert.equal(headers.Authorization, `Bearer ${stored?.access_token}`);
  assert.equal(headers["ChatGPT-Account-ID"], "acc_seam");
});

test("both halves write the token file at the same path, mode and shape", async (t) => {
  const dataDir = scratchDir(t);
  await signIn(dataDir);
  const path = join(dataDir, "codex-auth.json");
  const afterLogin = readFileSync(path, "utf8");
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // The runtime half rewrites the very same file on every refresh: widen it and prove the
  // rewrite restores both the bytes and the permissions the login half established.
  chmodSync(path, 0o644);
  const parsed = authoredReadAuth(dataDir);
  assert.ok(parsed);
  writeAuth(parsed, dataDir);
  assert.equal(readFileSync(path, "utf8"), afterLogin);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("both halves read the token file back the same way", async (t) => {
  const dataDir = scratchDir(t);
  assert.equal(authFilePath(dataDir), authoredAuthFilePath(dataDir));

  // No file yet: the wizard asks "already signed in?" before any login ever happened.
  assert.equal(readAuth(dataDir), null);
  assert.deepEqual(readAuth(dataDir), authoredReadAuth(dataDir));

  await signIn(dataDir);
  assert.deepEqual(readAuth(dataDir), authoredReadAuth(dataDir));

  // A half-written token file reads as "not signed in" on both sides — the wizard then
  // offers a login instead of announcing a configured install.
  writeFileSync(authFilePath(dataDir), '{"access_token": "trunc', "utf8");
  assert.equal(readAuth(dataDir), null);
  assert.deepEqual(readAuth(dataDir), authoredReadAuth(dataDir));
});

test("both halves speak the same OAuth protocol", async (t) => {
  // The constants are copied, not shared, so rotating one side alone must turn this red.
  assert.deepEqual(
    { ISSUER, CLIENT_ID, TOKEN_URL, ORIGINATOR },
    {
      ISSUER: AUTHORED_ISSUER,
      CLIENT_ID: AUTHORED_CLIENT_ID,
      TOKEN_URL: AUTHORED_TOKEN_URL,
      ORIGINATOR: AUTHORED_ORIGINATOR,
    },
  );

  // …and the login half really signs in with them, so the copies above are not decoration:
  // the same issuer, token endpoint and client_id the runtime half refreshes against.
  const requests = await signIn(scratchDir(t));
  const requestTo = (suffix: string): CapturedRequest => {
    const found = requests.find((request) => request.url.endsWith(suffix));
    assert.ok(found, `no request to ${suffix}`);
    return found;
  };
  const usercode = requestTo("/deviceauth/usercode");
  assert.equal(
    usercode.url,
    `${AUTHORED_ISSUER}/api/accounts/deviceauth/usercode`,
  );
  assert.equal(
    (JSON.parse(usercode.body) as { client_id: string }).client_id,
    AUTHORED_CLIENT_ID,
  );
  const exchange = requestTo("/oauth/token");
  assert.equal(exchange.url, AUTHORED_TOKEN_URL);
  assert.equal(
    new URLSearchParams(exchange.body).get("client_id"),
    AUTHORED_CLIENT_ID,
  );
});

test("both halves read the same claims out of an id_token", () => {
  for (const token of [idToken(), "garbage", ""]) {
    assert.deepEqual(
      accountFromIdToken(token),
      authoredAccountFromIdToken(token),
      token.slice(0, 16),
    );
  }
});
