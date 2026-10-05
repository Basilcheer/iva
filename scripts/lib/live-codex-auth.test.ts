// Живой ход на codex: вход установки копируется во временную Иву, а без входа — одна
// понятная строка вместо хода, который упал бы на «not logged in».
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
  const auth = JSON.stringify({ access_token: "a", refresh_token: "r" });
  await writeFile(join(from, "codex-auth.json"), auth, { mode: 0o644 });
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
