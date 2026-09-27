import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyRoot, gitRootFor } from "./version-layout.ts";

export const DEFAULT_UPDATE_BRANCH = "main";
export const UPDATE_BRANCH_CONFIG = "iva.updateBranch";

export type GitResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

export type Git = (...args: string[]) => Promise<GitResult>;

type ResolveUpdateTargetOptions = {
  git?: Git;
  remote?: string;
  defaultBranch?: string;
};

function output(result: GitResult): string {
  return String(result?.stdout ?? "").trim();
}

async function requireGit(git: Git, ...args: string[]): Promise<string> {
  const result = await git(...args);
  if (result.code !== 0)
    throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  return output(result);
}

async function fetchBranch(
  git: Git,
  remote: string,
  branch: string,
): Promise<string> {
  const valid = await git("check-ref-format", "--branch", branch);
  if (valid.code !== 0) throw new Error(`invalid update branch: ${branch}`);
  const fetched = await git("fetch", "--prune", remote, `refs/heads/${branch}`);
  if (fetched.code !== 0)
    throw new Error(fetched.stderr || `couldn't fetch ${remote}/${branch}`);
  return requireGit(git, "rev-parse", "FETCH_HEAD");
}

export async function resolveUpdateTarget({
  git,
  remote = "origin",
  defaultBranch = DEFAULT_UPDATE_BRANCH,
}: ResolveUpdateTargetOptions = {}) {
  if (typeof git !== "function")
    throw new Error("update target resolver requires git");
  const currentBranch = await requireGit(
    git,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  );
  if (!currentBranch || currentBranch === "HEAD")
    throw new Error("detached HEAD: switch to the update branch first");

  const configured = await git(
    "config",
    "--local",
    "--get",
    UPDATE_BRANCH_CONFIG,
  );
  const configuredBranch = configured.code === 0 ? output(configured) : "";
  if (configuredBranch) {
    return {
      branch: configuredBranch,
      currentBranch,
      configured: true,
      legacyMigration: false,
      targetHead: await fetchBranch(git, remote, configuredBranch),
    };
  }

  if (currentBranch !== defaultBranch) {
    const defaultHead = await fetchBranch(git, remote, defaultBranch);
    const merged = await git(
      "merge-base",
      "--is-ancestor",
      "HEAD",
      defaultHead,
    );
    if (merged.code === 0) {
      return {
        branch: defaultBranch,
        currentBranch,
        configured: false,
        legacyMigration: true,
        targetHead: defaultHead,
      };
    }
  }

  return {
    branch: currentBranch,
    currentBranch,
    configured: false,
    legacyMigration: false,
    targetHead: await fetchBranch(git, remote, currentBranch),
  };
}

export async function persistUpdateBranch(
  git: Git,
  branch: string,
): Promise<void> {
  await requireGit(git, "config", "--local", UPDATE_BRANCH_CONFIG, branch);
}

/** Канал установки: stable — только вышедшие версии (метки vX.Y.Z), beta — вершина ветки. */
export type Channel = "stable" | "beta";
export const CHANNEL_CONFIG = "iva.channel";
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** iva.channel; ключа нет — stable, чужое значение — stable и строка-предупреждение. */
export async function readChannel(git: Git): Promise<Channel> {
  const value = output(await git("config", "--local", "--get", CHANNEL_CONFIG));
  if (value === "beta" || value === "stable") return value;
  if (value)
    console.warn(
      `⚠️ ${CHANNEL_CONFIG}=${value}: not stable or beta, using stable`,
    );
  return "stable";
}

/**
 * Цель обновления по каналу. beta — вершина ветки обновления. stable — самая новая
 * метка vX.Y.Z, достижимая из вершины; установленный коммит (`installed`), который
 * сам эта метка или её потомок, — сама установка: назад обновление не ходит.
 */
export async function resolveChannelTarget(
  options: ResolveUpdateTargetOptions & { installed?: string },
) {
  const git = options.git!;
  const target = await resolveUpdateTarget(options);
  const channel = await readChannel(git);
  if (channel === "beta") return { ...target, channel };
  const remote = options.remote ?? "origin";
  await requireGit(git, "fetch", remote, "+refs/tags/*:refs/tags/*");
  const tags = await requireGit(
    git,
    "tag",
    "--list",
    "v*",
    "--merged",
    target.targetHead,
    "--sort=-v:refname",
  );
  const tag = tags.split("\n").find((name) => RELEASE_TAG.test(name));
  if (!tag)
    throw new Error(
      `no stable release on ${target.branch} yet; for the newest build run: iva beta`,
    );
  const release = await requireGit(git, "rev-parse", `${tag}^{commit}`);
  const installed = options.installed
    ? await requireGit(git, "rev-parse", options.installed)
    : "";
  const ahead =
    installed &&
    (await git("merge-base", "--is-ancestor", release, installed)).code === 0;
  return { ...target, channel, tag, targetHead: ahead ? installed : release };
}

/** Где лежит iva.channel: git установки и её зеркало (обновление читает зеркало). */
function channelRepos(root: string): string[] {
  const install = classifyRoot(root);
  const repos = new Set([install.home, gitRootFor(install)]);
  const isRepo = (dir: string) =>
    existsSync(join(dir, ".git")) || existsSync(join(dir, "HEAD"));
  return [...repos].filter(isRepo);
}

/** Канал установки для показа (iva version, status, меню); чужое значение — stable. */
export function channelOf(root: string): Channel {
  const repo = gitRootFor(classifyRoot(root));
  const args = ["-C", repo, "config", "--local", "--get", CHANNEL_CONFIG];
  const value = spawnSync("git", args, { encoding: "utf8" }).stdout?.trim();
  return value === "beta" ? "beta" : "stable";
}

/** iva beta / iva stable и кнопка меню: канал в git установки и в зеркале. */
export function setChannel(root: string, channel: Channel): boolean {
  const written = channelRepos(root).map(
    (repo) =>
      spawnSync("git", [
        "-C",
        repo,
        "config",
        "--local",
        CHANNEL_CONFIG,
        channel,
      ]).status === 0,
  );
  return written.length > 0 && written.every(Boolean);
}
