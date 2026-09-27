// iva beta / iva stable, строка канала в iva version и кнопка меню обслуживания: на
// временной установке под git с зеркалом repo/ (обновление читает канал из зеркала).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createCliMain } from "./main.ts";
import service, { type MenuServiceState } from "../lib/menu/service.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function install(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "iva-channel-cli-"));
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
  const channel = (dir: string) => {
    try {
      return git(dir, "config", "--local", "--get", "iva.channel");
    } catch {
      return "";
    }
  };
  return { home, channel };
}

function printed(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => void lines.push(line));
  return lines;
}

void test("iva beta / iva stable: канал в установке и зеркале, одна строка с iva update", async (t) => {
  const fx = install(t);
  const lines = printed(t);
  process.env.AGENT_LANGUAGE = "ru";
  const cli = createCliMain(fx.home);
  await cli.commands.beta([]);
  assert.equal(fx.channel(fx.home), "beta");
  assert.equal(fx.channel(join(fx.home, "repo")), "beta");
  assert.deepEqual(lines, ["Канал обновлений: бета. Обновиться: iva update"]);
  await cli.commands.stable([]);
  assert.equal(fx.channel(join(fx.home, "repo")), "stable");
  assert.equal(
    lines[1],
    "Канал обновлений: стабильный. Обновиться: iva update",
  );
  await cli.commands.version([]);
  assert.match(lines[2], /iva 0\.4\.9-beta\.1 · commit \S+ · channel stable/u);
});

void test("меню обслуживания: одна кнопка канала, нажатие переключает", async (t) => {
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
    /data="iva_menu:svc:ch"[^>]*>🧪 Канал обновлений: стабильный</u,
  );
  await service.on("ch", [], st, ctx);
  assert.equal(fx.channel(join(fx.home, "repo")), "beta");
  assert.match(screens[0], />🧪 Канал обновлений: бета</u);
  await service.on("ch", [], st, ctx);
  assert.equal(fx.channel(join(fx.home, "repo")), "stable");
});
