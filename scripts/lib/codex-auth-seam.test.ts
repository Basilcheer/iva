/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// The Codex subscription is signed in by scripts/lib/codex-oauth.ts (`iva login` and the setup
// wizard, which both have to run on an install whose agent/ is missing) and used by
// agent/lib/codex-auth.ts (the agent refreshing the token before every model call). Neither
// half may import the other at load time, so the OAuth constants, the token file path, its
// read, its atomic 0600 write and the id_token claim reader exist on both sides. This test is
// what ties the copies: it signs in through the login half, reads the result back through the
// runtime half, and holds the protocol constants of one side against the traffic of the other.
//
// The duplicated bodies — `parseJwt()` and `toAuth()` — are pinned the way the dual-language
// parser pairs are (`scripts/golden-parsers.test.ts`): one fixture table, both copies driven
// through it, so drift on either side turns red instead of splitting the halves in silence.
// What the runtime half does with the file afterwards (the refresh window, the refresh itself,
// its in-flight dedup and the re-read fallback) is `agent/lib/codex-auth.test.ts`.
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
  type CodexAuth,
  codexAuthHeaders,
  ISSUER as AUTHORED_ISSUER,
  ORIGINATOR as AUTHORED_ORIGINATOR,
  parseJwt as authoredParseJwt,
  readAuth as authoredReadAuth,
  toAuth as authoredToAuth,
  TOKEN_URL as AUTHORED_TOKEN_URL,
  writeAuth,
} from "#lib/codex-auth.ts";
import {
  accountFromIdToken,
  authFilePath,
  CLIENT_ID,
  ISSUER,
  ORIGINATOR,
  parseJwt,
  readAuth,
  runDeviceCodeLogin,
  toAuth,
  TOKEN_URL,
} from "./codex-oauth.ts";

// `unknown`, not `object`: a payload that is a bare JSON string or number is exactly the
// shape both copies of parseJwt() have to survive identically.
const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const jwt = (payload: unknown): string =>
  [b64url({ alg: "none" }), b64url(payload), "signature"].join(".");

/** An id_token carrying the account claim, valid far past any refresh skew. */
const idToken = (): string =>
  jwt({
    exp: 9_999_999_999,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc_seam",
      chatgpt_plan_type: "pro",
    },
  });

type TokenResponse = {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
};

/** What the fake OpenAI hands back — recomputable, so the pin can rebuild it verbatim. */
const loginTokens = (): TokenResponse => ({
  id_token: idToken(),
  access_token: idToken(),
  refresh_token: "refresh-1",
});

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
  const tokens = loginTokens();
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

// ── golden pin: the copied bodies ─────────────────────────────────────────────
// Fixtures shared by both copies, the way scripts/autograph/tests/golden/ is shared by the
// TS and Python parsers: one input, one expectation, two implementations asserted against it.
// The expectation here is "whatever the other copy says", which is the whole contract —
// neither half is the original, and either one drifting alone breaks a login or an hourly
// refresh nobody would notice until the token expired.

interface AuthCase {
  name: string;
  tokens: TokenResponse;
  prev?: Partial<CodexAuth>;
}

const STORED: Partial<CodexAuth> = {
  id_token: idToken(),
  refresh_token: "refresh-old",
  accountId: "acc_seam",
  planType: "pro",
};

const claimToken = (auth: unknown): string =>
  jwt({ exp: 9_999_999_999, "https://api.openai.com/auth": auth });

const AUTH_FIXTURES: AuthCase[] = [
  {
    name: "fresh login: everything comes off the wire",
    tokens: {
      id_token: idToken(),
      access_token: "at-1",
      refresh_token: "rt-1",
    },
  },
  {
    // The hourly refresh: the endpoint answers with one field and the rest has to survive.
    name: "refresh: only access_token, the file carries the rest",
    tokens: { access_token: "at-2" },
    prev: STORED,
  },
  {
    name: "refresh: the response rotates id_token and refresh_token",
    tokens: {
      id_token: claimToken({
        chatgpt_account_id: "acc_next",
        chatgpt_plan_type: "team",
      }),
      access_token: "at-3",
      refresh_token: "rt-3",
    },
    prev: STORED,
  },
  {
    // A new id_token without the claim wins over the stored account — the subscription
    // really did change, and keeping the old account id would sign every call as somebody else.
    name: "refresh: a claimless id_token clears the stored account",
    tokens: { id_token: jwt({ exp: 9_999_999_999 }), access_token: "at-4" },
    prev: STORED,
  },
  {
    name: "refresh: an unparsable id_token clears the stored account",
    tokens: { id_token: "garbage", access_token: "at-5" },
    prev: STORED,
  },
  {
    // Non-string claims are the shape a provider change would arrive in; both copies must
    // read them as "no account" rather than stringifying a number into a header.
    name: "claims of the wrong type read as no account",
    tokens: {
      id_token: claimToken({ chatgpt_account_id: 42, chatgpt_plan_type: "" }),
      access_token: "at-6",
    },
    prev: STORED,
  },
  {
    name: "an empty id_token is no id_token: the stored account stays",
    tokens: { id_token: "", access_token: "at-7" },
    prev: STORED,
  },
  {
    name: "nothing stored and nothing but an access_token returned",
    tokens: { access_token: "at-8" },
  },
  {
    name: "an empty refresh_token does not overwrite the stored one",
    tokens: { access_token: "at-9", refresh_token: "" },
    prev: STORED,
  },
];

const JWT_FIXTURES = [
  idToken(),
  jwt({ exp: 1, nested: { ok: [1, "два", null] } }),
  jwt("строка"),
  "",
  "garbage",
  ".",
  "..",
  "a..c",
  "a.b.c",
  `a.${b64url({ exp: 1 })}`,
  `a.${b64url({ exp: 1 })}.c.d`,
  "a.%%%.c",
];

type Outcome = { value: unknown } | { error: string };

/** Both copies must agree on failure too: the throw is what callers catch. */
const outcome = (run: () => unknown): Outcome => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: (error as Error).message };
  }
};

test("the copies are two functions, not one re-export", () => {
  // Pinning a function against itself would pass forever; the seam only exists while the
  // authored tree keeps its own body (it may not import scripts/ at load time).
  assert.notEqual(toAuth, authoredToAuth);
  assert.notEqual(parseJwt, authoredParseJwt);
});

test("both halves build the same stored auth out of a token response", () => {
  for (const { name, tokens, prev } of AUTH_FIXTURES) {
    assert.deepEqual(toAuth(tokens, prev), authoredToAuth(tokens, prev), name);
  }
});

test("both halves parse the same payload out of a JWT", () => {
  for (const token of JWT_FIXTURES) {
    assert.deepEqual(
      outcome(() => parseJwt(token)),
      outcome(() => authoredParseJwt(token)),
      JSON.stringify(token),
    );
  }
});

test("the login half stores exactly what its own toAuth() builds", async (t) => {
  // Keeps the pin honest: the exported copies above are the ones the flow really runs, so
  // a fixture-only agreement cannot pass while the shipped path does something else.
  const dataDir = scratchDir(t);
  await signIn(dataDir);
  assert.deepEqual(authoredReadAuth(dataDir), toAuth(loginTokens()));
});

test("randomized token responses keep the copies identical (seed exposed)", () => {
  const seed = Number(process.env.IVA_TEST_SEED ?? Date.now() % 100_000);
  console.log(
    `randomized codex-auth seam seed: ${seed} (IVA_TEST_SEED to replay)`,
  );
  let lcg = seed >>> 0;
  const rand = (): number => {
    lcg = (lcg * 1664525 + 1013904223) >>> 0;
    return lcg / 2 ** 32;
  };
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(rand() * values.length)];

  for (let i = 0; i < 200; i++) {
    const account = pick([`acc_${i}`, "", 42, null, undefined, { id: i }]);
    const plan = pick(["pro", "team", "", 7, null, undefined]);
    const token = pick([
      claimToken({ chatgpt_account_id: account, chatgpt_plan_type: plan }),
      claimToken(pick([null, "claim", 5, []])),
      jwt({ exp: Math.floor(rand() * 2 ** 31) }),
      pick(["", "garbage", "a.b.c", `x.${b64url({ a: i })}.y`]),
      undefined,
    ]);
    const tokens: TokenResponse = {
      access_token: `at-${i}`,
      ...(token === undefined ? {} : { id_token: token }),
      ...(rand() < 0.5 ? { refresh_token: pick(["", `rt-${i}`]) } : {}),
    };
    const prev: Partial<CodexAuth> = pick([{}, STORED, { accountId: null }]);
    const seen = JSON.stringify({ i, tokens, prev });
    assert.deepEqual(toAuth(tokens, prev), authoredToAuth(tokens, prev), seen);
    if (token !== undefined)
      assert.deepEqual(
        outcome(() => parseJwt(token)),
        outcome(() => authoredParseJwt(token)),
        seen,
      );
  }
});
