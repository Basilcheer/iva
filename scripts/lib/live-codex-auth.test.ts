// Живой ход на codex: вход установки копируется во временную Иву, а без входа — одна
// понятная строка вместо хода, который упал бы на «not logged in».
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CODEX_NO_LOGIN, carryCodexLogin } from "./live-codex-auth.ts";

/** access_token как JWT с полем exp: столько секунд ему осталось жить. */
function jwt(secondsLeft: number): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + secondsLeft;
  return `${part({ alg: "none" })}.${part({ exp })}.sig`;
}

async function dirs(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "iva-live-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = join(root, "install-data");
  const to = join(root, "live-data");
  await mkdir(from);
  await mkdir(to);
  return { from, to };
}

await test("codex: вход установки копируется во временную Иву с правами 0600", async (t) => {
  const { from, to } = await dirs(t);
  const auth = JSON.stringify({
    access_token: jwt(86_400),
    refresh_token: "r",
  });
  await writeFile(join(from, "codex-auth.json"), auth, { mode: 0o644 });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("a token with a day left is not refreshed");
  });
  assert.equal(await carryCodexLogin("codex", from, to), null);
  const copy = join(to, "codex-auth.json");
  assert.equal(await readFile(copy, "utf8"), auth);
  assert.equal((await stat(copy)).mode & 0o777, 0o600);
});

await test("codex без входа: строка «нет входа», файла не появилось", async (t) => {
  const { from, to } = await dirs(t);
  assert.equal(await carryCodexLogin("codex", from, to), CODEX_NO_LOGIN);
  assert.equal(CODEX_NO_LOGIN, "codex: нет входа, iva login");
  assert.ok(!existsSync(join(to, "codex-auth.json")));
});

await test("другой провайдер: вход codex не трогается", async (t) => {
  const { from, to } = await dirs(t);
  await writeFile(join(from, "codex-auth.json"), "{}");
  for (const provider of ["claude", "opencode", undefined])
    assert.equal(await carryCodexLogin(provider, from, to), null);
  assert.ok(!existsSync(join(to, "codex-auth.json")));
});

// Токен установки, которому осталось меньше хода с запасом, временная Ива обновила бы в своей
// копии: новый refresh-токен ушёл бы вместе с песочницей, а у установки остался бы старый.
// Поэтому он обновляется в самой установке её же путём (agent/lib/codex-auth.ts), до копии.
await test("codex: a token about to expire is refreshed in the installation before the copy", async (t) => {
  const { from, to } = await dirs(t);
  const old = {
    access_token: jwt(600),
    refresh_token: "r-old",
    accountId: "acc",
  };
  await writeFile(join(from, "codex-auth.json"), JSON.stringify(old), {
    mode: 0o600,
  });
  const fresh = jwt(86_400);
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ access_token: fresh, refresh_token: "r-new" }),
      ),
    );
  });
  assert.equal(await carryCodexLogin("codex", from, to), null);
  assert.equal(bodies.length, 1);
  assert.equal((bodies[0] as { refresh_token: string }).refresh_token, "r-old");
  const installed = JSON.parse(
    await readFile(join(from, "codex-auth.json"), "utf8"),
  ) as { access_token: string; refresh_token: string };
  assert.equal(
    installed.refresh_token,
    "r-new",
    "the installation keeps the new one",
  );
  assert.equal(installed.access_token, fresh);
  assert.equal(
    await readFile(join(to, "codex-auth.json"), "utf8"),
    await readFile(join(from, "codex-auth.json"), "utf8"),
    "the live Iva gets the fresh token and has nothing to refresh",
  );
});

// Обновление токена — забота о запасе, не условие хода: сеть или 5xx на auth.openai.com
// не роняют прогон. Строка в журнал, файл установки копируется как есть, установка не тронута.
// Часы сдвинуты на минуты вперёд: принудительное обновление в codex-auth.ts раз в минуту.
for (const [index, [label, failure]] of (
  [
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "5xx",
      () => Promise.resolve(new Response("upstream down", { status: 503 })),
    ],
  ] as const
).entries()) {
  await test(`codex: a failed refresh (${label}) does not stop the live turn, the file is copied as is`, async (t) => {
    const { from, to } = await dirs(t);
    const auth = JSON.stringify({
      access_token: jwt(600),
      refresh_token: "r",
    });
    await writeFile(join(from, "codex-auth.json"), auth, { mode: 0o600 });
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.now() + (index + 2) * 120_000,
    });
    const fetches = t.mock.method(globalThis, "fetch", failure);
    const lines: string[] = [];
    assert.equal(
      await carryCodexLogin("codex", from, to, (line) => lines.push(line)),
      null,
    );
    assert.equal(fetches.mock.callCount(), 1, "the refresh was attempted");
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^codex: не удалось обновить токен, копирую как есть: \S/u,
    );
    assert.equal(await readFile(join(from, "codex-auth.json"), "utf8"), auth);
    assert.equal(await readFile(join(to, "codex-auth.json"), "utf8"), auth);
  });
}
