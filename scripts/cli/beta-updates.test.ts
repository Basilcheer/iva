// iva beta / iva stable, строка обновлений в iva version и кнопка меню обслуживания: на
// временной установке под git с зеркалом repo/ (обновление читает iva.beta из зеркала).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createCliMain, dispatchCli } from "./main.ts";
import service, { type MenuServiceState } from "../lib/menu/service.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function install(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "iva-beta-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  git(home, "init", "-q", "-b", "main");
  writeFileSync(join(home, "package.json"), '{"version":"0.4.9-beta.1"}\n');
  git(
    home,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "i",
    "--allow-empty",
  );
  git(home, "clone", "-q", "--mirror", join(home, ".git"), join(home, "repo"));
  const read = (key: string) => (dir: string) => {
    try {
      return git(dir, "config", "--local", "--get", key);
    } catch {
      return "";
    }
  };
  return { home, beta: read("iva.beta"), branch: read("iva.updateBranch") };
}

function printed(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => void lines.push(line));
  return lines;
}

void test("iva beta / iva stable: iva.beta и ветка beta/main в установке и зеркале, одна строка с iva update", async (t) => {
  const fx = install(t);
  const lines = printed(t);
  process.env.AGENT_LANGUAGE = "ru";
  const cli = createCliMain(fx.home);
  await cli.commands.beta([]);
  assert.equal(fx.beta(fx.home), "true");
  assert.equal(fx.beta(join(fx.home, "repo")), "true");
  assert.equal(fx.branch(fx.home), "beta");
  assert.equal(fx.branch(join(fx.home, "repo")), "beta");
  assert.deepEqual(lines, ["Обновления: бета. Обновиться: iva update"]);
  await cli.commands.stable([]);
  assert.equal(fx.beta(join(fx.home, "repo")), "");
  assert.equal(fx.beta(fx.home), "");
  assert.equal(fx.branch(fx.home), "main");
  assert.equal(fx.branch(join(fx.home, "repo")), "main");
  assert.equal(lines[1], "Обновления: стабильные. Обновиться: iva update");
  await cli.commands.version([]);
  assert.match(lines[2], /iva 0\.4\.9-beta\.1 · commit \S+ · updates stable/u);
});

void test("меню обслуживания: одна кнопка обновлений, нажатие переключает", async (t) => {
  const fx = install(t);
  const screens: string[] = [];
  const st = {
    chatId: 1,
    userId: "1",
    screen: "svc",
    msgId: 1,
  } as MenuServiceState;
  const ctx = {
    deps: { root: fx.home, envPath: "", dataDir: fx.home },
    flows: { get: () => st, screen: async () => {} },
    tr: (_en: string, ru: string) => ru,
    show: async () => void screens.push((await service.render(st, ctx)).text),
  };
  const first = (await service.render(st, ctx)).text;
  assert.match(
    first,
    /data="iva_menu:svc:beta"[^>]*>🧪 Обновления: стабильные</u,
  );
  await service.on("beta", [], st, ctx);
  assert.equal(fx.beta(join(fx.home, "repo")), "true");
  assert.equal(fx.branch(join(fx.home, "repo")), "beta");
  assert.match(screens[0], />🧪 Обновления: бета</u);
  await service.on("beta", [], st, ctx);
  assert.equal(fx.beta(join(fx.home, "repo")), "");
  assert.equal(fx.branch(join(fx.home, "repo")), "main");
});

void test("iva beta вне git-дерева: одна строка отказа и код 1, без стека", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-beta-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = createCliMain(dir);
  const refused: string[] = [];
  const codes: number[] = [];
  await dispatchCli(["beta"], cli.commands, {
    bad: (line) => void refused.push(line),
    help: () => {},
    exit: ((code: number) => void codes.push(code)) as (code: number) => never,
  });
  assert.deepEqual(refused, [
    "no git repository here: the setting was not recorded",
  ]);
  assert.deepEqual(codes, [1]);
});
