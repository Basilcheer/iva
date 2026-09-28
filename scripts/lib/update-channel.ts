import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyRoot, gitRootFor } from "./version-layout.ts";

export const DEFAULT_UPDATE_BRANCH = "main";
/** Ветка бета-обновлений: в main только выпуски (ADR-0018). */
const BETA_BRANCH = "beta";
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

/** Бета-обновления (Beta updates): `iva.beta` = true — обновление ставит вершину ветки;
 * ключа нет — ставит новейший выпуск (Release, метка vX.Y.Z). ADR-0017. */
export const BETA_CONFIG = "iva.beta";
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** Включены ли бета-обновления; чужое значение — нет, и строка-предупреждение. */
export async function readBeta(git: Git): Promise<boolean> {
  const value = output(await git("config", "--local", "--get", BETA_CONFIG));
  if (value && value !== "true" && value !== "false")
    console.warn(`⚠️ ${BETA_CONFIG}=${value}: not true, installing releases`);
  return value === "true";
}

/**
 * Цель обновления. Бета — вершина ветки обновления. Иначе — новейший выпуск: метка
 * vX.Y.Z, достижимая из вершины; установленный коммит (`installed`), который сам этот
 * выпуск или его потомок, — сама установка: назад обновление не ходит.
 */
export async function resolveReleaseTarget(
  options: ResolveUpdateTargetOptions & { installed?: string },
) {
  const git = options.git!;
  const target = await resolveUpdateTarget(options);
  if (await readBeta(git)) return { ...target, beta: true };
  const remote = options.remote ?? "origin";
  // --prune: метка, удалённая из origin (отозванный выпуск), уходит и отсюда.
  await requireGit(git, "fetch", "--prune", remote, "+refs/tags/*:refs/tags/*");
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
      `no release on ${target.branch} yet; for the newest build run: iva beta`,
    );
  const release = await requireGit(git, "rev-parse", `${tag}^{commit}`);
  const installed = options.installed
    ? await requireGit(git, "rev-parse", options.installed)
    : "";
  const ahead =
    installed &&
    (await git("merge-base", "--is-ancestor", release, installed)).code === 0;
  return {
    ...target,
    beta: false,
    tag,
    // Установка новее выпуска (его потомок), а не он сам.
    newer: Boolean(ahead) && installed !== release,
    targetHead: ahead ? installed : release,
  };
}

/** Где лежит iva.beta: git установки и её зеркало (обновление читает зеркало). */
function betaRepos(root: string): string[] {
  const install = classifyRoot(root);
  const repos = new Set([install.home, gitRootFor(install)]);
  const isRepo = (dir: string) =>
    existsSync(join(dir, ".git")) || existsSync(join(dir, "HEAD"));
  return [...repos].filter(isRepo);
}

/** Бета-обновления установки для показа (iva version, status, меню). */
export function betaOf(root: string): boolean {
  const repo = gitRootFor(classifyRoot(root));
  const args = ["-C", repo, "config", "--local", "--get", BETA_CONFIG];
  return spawnSync("git", args, { encoding: "utf8" }).stdout?.trim() === "true";
}

/** iva beta / iva stable и кнопка меню: бета — iva.beta=true и ветка beta, стабильные —
 * ключа нет и ветка main (ADR-0018), в установке и в зеркале. */
export function setBeta(root: string, on: boolean): boolean {
  const beta = on ? [BETA_CONFIG, "true"] : ["--unset-all", BETA_CONFIG];
  const branch = [
    UPDATE_BRANCH_CONFIG,
    on ? BETA_BRANCH : DEFAULT_UPDATE_BRANCH,
  ];
  const config = (repo: string, args: string[]) =>
    spawnSync("git", ["-C", repo, "config", "--local", ...args]).status;
  const written = betaRepos(root).map((repo) => {
    const status = config(repo, beta);
    const flag = status === 0 || (!on && status === 5); // 5: ключа и так нет
    return flag && config(repo, branch) === 0;
  });
  return written.length > 0 && written.every(Boolean);
}
