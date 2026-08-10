/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Рантайм-половина шва подписки: не вход, а то, что происходит перед КАЖДЫМ запросом
// модели — окно рефреша, сам рефреш, дедуп конкурентных ходов и перечитывание файла,
// когда рефреш не удался. Вход живёт в scripts/lib/codex-oauth.ts, и совпадение двух
// половин пинует scripts/lib/codex-auth-seam.test.ts; сюда он не заглядывает — та
// половина не должна грузиться в authored tree.
//
// Сети здесь нет вовсе: единственный исходящий вызов половины — POST на TOKEN_URL, и его
// подменяет локальный мок, который валит тест на любом другом адресе.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authFilePath,
  CLIENT_ID,
  CLIENT_VERSION,
  type CodexAuth,
  codexAuthHeaders,
  getAccessToken,
  ORIGINATOR,
  readAuth,
  TOKEN_URL,
  writeAuth,
} from "./codex-auth.ts";

const nowS = (): number => Math.floor(Date.now() / 1000);

const b64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const jwt = (payload: object): string =>
  [b64url({ alg: "none" }), b64url(payload), "signature"].join(".");

/** access_token, протухающий через `expiresInS` секунд; label разводит токены между собой. */
const accessToken = (expiresInS: number, label: string): string =>
  jwt({ exp: nowS() + expiresInS, label });

const idToken = (accountId: string, planType: string): string =>
  jwt({
    exp: nowS() + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
    },
  });

function scratchDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-codex-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Кладёт файл токена таким, каким его оставил бы вход или предыдущий рефреш. */
function storeAuth(dataDir: string, patch: Partial<CodexAuth> = {}): CodexAuth {
  const auth: CodexAuth = {
    id_token: idToken("acc_1", "pro"),
    access_token: accessToken(3600, "stored"),
    refresh_token: "refresh-1",
    accountId: "acc_1",
    planType: "pro",
    ...patch,
  };
  writeAuth(auth, dataDir);
  return auth;
}

type TokenCall = { url: string; init: RequestInit | undefined; body: string };

/**
 * Фейковый токен-эндпоинт вместо globalThis.fetch. Любой адрес, кроме TOKEN_URL, — красный
 * тест: рантайм-половина не имеет права ходить никуда ещё.
 */
function tokenEndpoint(
  t: { after(fn: () => void): void },
  handler: (call: TokenCall) => Response | Promise<Response>,
): TokenCall[] {
  const calls: TokenCall[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
    assert.equal(
      url,
      TOKEN_URL,
      "the runtime half calls the token endpoint only",
    );
    const call: TokenCall = {
      url,
      init,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return calls;
}

const neverCalled = (): Response => {
  throw new Error("token endpoint must not be called");
};

test("a token with time left is served straight off the file", async (t) => {
  const dataDir = scratchDir(t);
  // 301 секунда: окно рефреша — последние 5 минут жизни токена (REFRESH_SKEW_S).
  const stored = storeAuth(dataDir, {
    access_token: accessToken(301, "fresh"),
  });
  const calls = tokenEndpoint(t, neverCalled);

  const headers = await codexAuthHeaders(dataDir);
  assert.deepEqual(headers, {
    Authorization: `Bearer ${stored.access_token}`,
    originator: ORIGINATOR,
    "User-Agent": `${ORIGINATOR}/${CLIENT_VERSION}`,
    "ChatGPT-Account-ID": "acc_1",
  });

  // Вход без аккаунта (клейма в id_token не было) — заголовка нет вовсе, а не пустой.
  storeAuth(dataDir, {
    access_token: accessToken(301, "fresh"),
    accountId: null,
  });
  assert.equal(
    "ChatGPT-Account-ID" in (await codexAuthHeaders(dataDir)),
    false,
  );
  assert.equal(calls.length, 0);
});

test("the last five minutes of a token count as expired", async (t) => {
  const dataDir = scratchDir(t);
  const refreshed = accessToken(3600, "refreshed");
  const calls = tokenEndpoint(t, () =>
    Response.json({ access_token: refreshed }),
  );

  // Ровно в окне рефреша: токен ещё валиден для бэкенда, но ход его уже не берёт.
  storeAuth(dataDir, { access_token: accessToken(299, "expiring") });
  assert.equal((await getAccessToken(dataDir)).accessToken, refreshed);
  assert.equal(calls.length, 1);

  // Токен без exp и вовсе не токен читаются как протухшие: гадать нечем, надо обновлять.
  for (const broken of [jwt({ label: "no-exp" }), "not-a-jwt", "a.b.c"]) {
    calls.length = 0;
    storeAuth(dataDir, { access_token: broken });
    assert.equal((await getAccessToken(dataDir)).accessToken, refreshed);
    assert.equal(calls.length, 1, `no refresh for ${JSON.stringify(broken)}`);
  }
});

test("a refresh posts the stored refresh_token and rewrites the file in place", async (t) => {
  const dataDir = scratchDir(t);
  const stored = storeAuth(dataDir, {
    access_token: accessToken(-60, "expired"),
  });
  const refreshed = accessToken(3600, "refreshed");
  // Ответ без id_token и без refresh_token — обычный случай: обновилось только одно поле.
  const calls = tokenEndpoint(t, () =>
    Response.json({ access_token: refreshed }),
  );

  const headers = await codexAuthHeaders(dataDir);
  assert.equal(headers.Authorization, `Bearer ${refreshed}`);
  assert.equal(headers["ChatGPT-Account-ID"], "acc_1");

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.init?.method, "POST");
  assert.deepEqual(call.init?.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(call.body), {
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: "refresh-1",
  });

  // Файл переписан на месте: новый access_token, остальное — из прежнего входа, права 0600.
  assert.deepEqual(readAuth(dataDir), {
    id_token: stored.id_token,
    access_token: refreshed,
    refresh_token: "refresh-1",
    accountId: "acc_1",
    planType: "pro",
  });
  assert.equal(statSync(authFilePath(dataDir)).mode & 0o777, 0o600);
});

test("a rotated id_token moves the account the next turn talks to", async (t) => {
  const dataDir = scratchDir(t);
  storeAuth(dataDir, { access_token: accessToken(-1, "expired") });
  const rotated = idToken("acc_2", "team");
  const refreshed = accessToken(3600, "refreshed");
  tokenEndpoint(t, () =>
    Response.json({
      id_token: rotated,
      access_token: refreshed,
      refresh_token: "refresh-2",
    }),
  );

  const headers = await codexAuthHeaders(dataDir);
  assert.equal(headers["ChatGPT-Account-ID"], "acc_2");
  assert.deepEqual(readAuth(dataDir), {
    id_token: rotated,
    access_token: refreshed,
    refresh_token: "refresh-2",
    accountId: "acc_2",
    planType: "team",
  });
});

test("no usable token file means `iva login`, not a request", async (t) => {
  const dataDir = scratchDir(t);
  const calls = tokenEndpoint(t, neverCalled);

  await assert.rejects(getAccessToken(dataDir), /iva login/u);
  // Файл есть, но access_token в нём нет — читается так же строго, как отсутствие файла.
  writeFileSync(authFilePath(dataDir), '{"refresh_token":"refresh-1"}\n');
  await assert.rejects(getAccessToken(dataDir), /iva login/u);
  assert.equal(calls.length, 0);
});

test("concurrent turns share one refresh and the next turn gets its own", async (t) => {
  const dataDir = scratchDir(t);
  storeAuth(dataDir, { access_token: accessToken(-1, "expired") });

  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Первый ответ сам протухший: ход его отдаст, но следующий ход обязан пойти за новым —
  // это и показывает, что слот дедупа освобождается, а не залипает навсегда.
  const responses = [
    accessToken(10, "shared"),
    accessToken(3600, "second-round"),
  ];
  const calls = tokenEndpoint(t, async () => {
    await gate;
    return Response.json({ access_token: responses[calls.length - 1] });
  });

  // Оба хода стартуют до того, как эндпоинт ответил, — ровно гонка модели с самой собой.
  const first = getAccessToken(dataDir);
  const second = getAccessToken(dataDir);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1, "two turns must not refresh twice");
  assert.equal(a.accessToken, responses[0]);
  assert.equal(b.accessToken, responses[0]);
  assert.equal(a.accountId, "acc_1");

  const third = await getAccessToken(dataDir);
  assert.equal(calls.length, 2);
  assert.equal(third.accessToken, responses[1]);
});

test("a failed refresh takes the token another process just wrote", async (t) => {
  const dataDir = scratchDir(t);
  storeAuth(dataDir, { access_token: accessToken(-1, "expired") });
  const winner = accessToken(3600, "written-by-cli");
  // `iva login` в соседнем терминале успел переписать файл, пока сервер шёл за рефрешем:
  // 400 на уже отозванный refresh_token — следствие того самого входа, а не отказ доступа.
  const calls = tokenEndpoint(t, () => {
    storeAuth(dataDir, { access_token: winner, accountId: "acc_cli" });
    return new Response("refresh token revoked", { status: 400 });
  });

  const { accessToken: served, accountId } = await getAccessToken(dataDir);
  assert.equal(served, winner);
  assert.equal(accountId, "acc_cli");
  assert.equal(calls.length, 1);
});

test("a failed refresh with nothing fresher throws and keeps the file", async (t) => {
  const dataDir = scratchDir(t);
  storeAuth(dataDir, { access_token: accessToken(-1, "expired") });
  const before = readFileSync(authFilePath(dataDir), "utf8");
  const recovered = accessToken(3600, "recovered");
  let down = true;
  const calls = tokenEndpoint(t, () =>
    down
      ? new Response("upstream boom ".repeat(100), { status: 502 })
      : Response.json({ access_token: recovered }),
  );

  await assert.rejects(getAccessToken(dataDir), (error: Error) => {
    assert.match(error.message, /^token refresh failed: 502 upstream boom/u);
    // Тело ответа режется, чтобы страница ошибки провайдера не уехала в лог целиком.
    assert.ok(error.message.length < 360, String(error.message.length));
    return true;
  });
  // Файл — единственный носитель refresh_token: сбойный рефреш не имеет права его стереть.
  assert.equal(readFileSync(authFilePath(dataDir), "utf8"), before);

  // И слот дедупа отпущен: следующий ход честно идёт за токеном, а не наследует отказ.
  down = false;
  const { accessToken: served } = await getAccessToken(dataDir);
  assert.equal(served, recovered);
  assert.equal(calls.length, 2);
  assert.equal(readAuth(dataDir)?.access_token, recovered);
});
