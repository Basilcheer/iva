/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// The Codex subscription is signed in by scripts/lib/codex-oauth.ts (`iva login`, which has to
// run on an install whose agent/ is missing) and used by agent/lib/codex-auth.ts (the agent
// refreshing the token before every model call). Neither half may import the other at load
// time, so the OAuth constants, the atomic 0600 write and the id_token claim reader exist on
// both sides. What ties them is the file itself: this test signs in through the login half and
// reads the result back through the runtime half.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountFromIdToken as authoredAccountFromIdToken,
  codexAuthHeaders,
  readAuth,
  writeAuth,
} from "#lib/codex-auth.ts";
import { accountFromIdToken, runDeviceCodeLogin } from "./codex-oauth.ts";

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

/** Drives the device-code flow against a fake OpenAI, so nothing leaves the process. */
async function signIn(dataDir: string): Promise<void> {
  const tokens = {
    id_token: idToken(),
    access_token: idToken(),
    refresh_token: "refresh-1",
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
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
}

test("a login writes the token file the runtime half reads back", async (t) => {
  const dataDir = scratchDir(t);
  await signIn(dataDir);

  const stored = readAuth(dataDir);
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
  const parsed = readAuth(dataDir);
  assert.ok(parsed);
  writeAuth(parsed, dataDir);
  assert.equal(readFileSync(path, "utf8"), afterLogin);
  assert.equal(statSync(path).mode & 0o777, 0o600);
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
