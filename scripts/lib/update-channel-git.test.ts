// Каналы обновлений на настоящем git: зеркало установки (bare, как ~/iva/repo), удалённый
// репозиторий с метками vX.Y.Z и коммитами после них. Одна строка таблицы отказов спеки
// beta-channel — один тест.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveChannelTarget } from "./update-channel.ts";
import { gitAt, inspectUpstream } from "./update-check.ts";
import { ensureMirror, resolveTarget } from "../cli/version-update-command.ts";
import { parseVersionName, versionName } from "./version-store.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** seed пушит в remote; mirror — зеркало установки; commit(v) — коммит с версией v. */
function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), "iva-channel-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const [remote, seed, mirror] = ["remote.git", "seed", "mirror.git"].map(
    (name) => join(temp, name),
  );
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  git(temp, "init", "-q", "--bare", "-b", "main", remote);
  git(seed, "remote", "add", "origin", remote);
  const commit = (version: string, tag = false) => {
    writeFileSync(join(seed, "package.json"), `{"version":"${version}"}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", version, "--allow-empty");
    if (tag) git(seed, "tag", `v${version}`);
    git(seed, "push", "-q", "--tags", "origin", "HEAD");
    return git(seed, "rev-parse", "HEAD");
  };
  const first = commit("1.0.0", true);
  git(temp, "clone", "-q", "--mirror", remote, mirror);
  const channel = (value: string) =>
    git(mirror, "config", "iva.channel", value);
  const target = (installed?: string) =>
    resolveChannelTarget({ git: (...args) => gitAt(mirror, args), installed });
  return { temp, remote, seed, mirror, first, commit, channel, target };
}

void test("stable, установка на коммите после последней метки: цель — она сама, ничего не ставится, не откат", async (t) => {
  const fx = fixture(t);
  const after = fx.commit("1.0.0");
  const target = await fx.target(after);
  assert.equal(target.channel, "stable");
  assert.equal(target.targetHead, after);
  assert.deepEqual(await resolveTarget(fx.mirror, after), {
    sha: after,
    version: "1.0.0",
    channel: "stable",
  });
});

void test("stable, вышла новая метка: ставится метка, а не вершина ветки", async (t) => {
  const fx = fixture(t);
  const released = fx.commit("1.1.0", true);
  fx.commit("1.1.0");
  assert.equal((await fx.target(fx.first)).targetHead, released);
  assert.equal((await resolveTarget(fx.mirror, fx.first)).sha, released);
});

void test("beta: вершина ветки, а не метка", async (t) => {
  const fx = fixture(t);
  fx.commit("1.1.0", true);
  const tip = fx.commit("1.2.0-beta.1");
  fx.channel("beta");
  const target = await fx.target(fx.first);
  assert.equal(target.channel, "beta");
  assert.equal(target.targetHead, tip);
  assert.equal((await resolveTarget(fx.mirror, fx.first)).sha, tip);
});

void test("меток нет вовсе: stable — отказ с советом iva beta, ни падения, ни вершины ветки", async (t) => {
  const fx = fixture(t);
  git(fx.seed, "push", "-q", "origin", ":refs/tags/v1.0.0");
  git(fx.seed, "tag", "-d", "v1.0.0");
  git(fx.mirror, "tag", "-d", "v1.0.0");
  fx.commit("1.1.0");
  await assert.rejects(fx.target(fx.first), /iva beta/u);
  await assert.rejects(resolveTarget(fx.mirror, fx.first), /iva beta/u);
});

void test("iva.channel — мусор: как stable и строка-предупреждение", async (t) => {
  const fx = fixture(t);
  fx.commit("1.1.0");
  fx.channel("nightly");
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: string) => warnings.push(line));
  const target = await fx.target(fx.first);
  assert.equal(target.channel, "stable");
  assert.equal(target.targetHead, fx.first);
  assert.match(warnings.join("\n"), /iva\.channel.*nightly.*stable/u);
});

void test("сеть при забирании меток: тот же отказ, что при сети, а не «уже последняя»; бета — как сейчас", async (t) => {
  const fx = fixture(t);
  const tip = fx.commit("1.1.0");
  git(fx.mirror, "fetch", "-q", "origin");
  rmSync(fx.remote, { recursive: true, force: true });
  await assert.rejects(fx.target(tip), /couldn't fetch|fatal/u);
  await assert.rejects(resolveTarget(fx.mirror, tip), /couldn't fetch|fatal/u);
  fx.channel("beta");
  // Бета без сети, как и прежде: свежайший коммит зеркала, обновление — no-op.
  assert.equal((await resolveTarget(fx.mirror, tip)).sha, tip);
});

void test("переключение beta → stable на установке новее метки: ничего не ставится до следующей метки", async (t) => {
  const fx = fixture(t);
  fx.channel("beta");
  const installed = fx.commit("1.1.0-beta.1");
  assert.equal((await fx.target(installed)).targetHead, installed);
  fx.channel("stable");
  assert.equal((await fx.target(installed)).targetHead, installed);
  const next = fx.commit("1.1.0", true);
  assert.equal((await fx.target(installed)).targetHead, next);
  // Ежедневная проверка предлагает этот релиз: бета 1.1.0-beta.1 младше 1.1.0.
  const info = await inspectUpstream({ root: fx.mirror, head: installed });
  assert.equal(info.hasVersionUpdate, true);
  assert.equal(info.remoteVersion, "1.1.0");
});

void test("ветка обновления не main: каналы работают на её вершине и её метках", async (t) => {
  const fx = fixture(t);
  git(fx.seed, "switch", "-q", "-c", "dev");
  const devTag = fx.commit("1.5.0", true);
  const devTip = fx.commit("1.6.0-beta.1");
  git(fx.seed, "switch", "-q", "main");
  fx.commit("2.0.0", true);
  git(fx.mirror, "config", "iva.updateBranch", "dev");
  const stable = await fx.target(fx.first);
  assert.equal(stable.branch, "dev");
  assert.equal(stable.targetHead, devTag);
  fx.channel("beta");
  assert.equal((await fx.target(fx.first)).targetHead, devTip);
});

void test("зеркало ~/iva/repo получает iva.channel установки так же, как iva.updateBranch", async (t) => {
  const fx = fixture(t);
  const home = join(fx.temp, "home");
  git(fx.temp, "clone", "-q", fx.remote, home);
  git(home, "config", "iva.channel", "beta");
  git(home, "config", "iva.updateBranch", "main");
  const repo = await ensureMirror(home);
  assert.equal(git(repo, "config", "--get", "iva.channel"), "beta");
  assert.equal(git(repo, "config", "--get", "iva.updateBranch"), "main");
});

void test("каталог версии беты `0.4.9-beta.1-<sha12>` разбирают и новый код, и v0.4.8", async (t) => {
  const sha = "0123456789ab";
  const name = versionName("0.4.9-beta.1", sha, "89abcdef");
  assert.deepEqual(
    { ...parseVersionName(name) },
    { ...parseVersionName(`0.4.9-beta.1-${sha}+89abcdef`) },
  );
  assert.equal(parseVersionName(name)?.version, "0.4.9-beta.1");
  const dir = mkdtempSync(join(tmpdir(), "iva-v048-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, "data-dir.ts");
  writeFileSync(
    old,
    git(process.cwd(), "show", "v0.4.8:packages/data-dir/index.ts"),
  );
  const { VERSION_DIRECTORY_PATTERN } = (await import(old)) as {
    VERSION_DIRECTORY_PATTERN: RegExp;
  };
  const match = VERSION_DIRECTORY_PATTERN.exec(name);
  assert.equal(match?.[1], "0.4.9-beta.1");
  assert.equal(match?.[2], sha);
});
