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

/** Ветку не получить: нет сети или такой ветки у origin. Единственная ошибка, при которой
 * бета молчит (daily) или отказывает строкой «ветка beta недоступна» (iva update). */
export class BranchUnavailableError extends Error {}

async function fetchBranch(
  git: Git,
  remote: string,
  branch: string,
): Promise<string> {
  const valid = await git("check-ref-format", "--branch", branch);
  if (valid.code !== 0) throw new Error(`invalid update branch: ${branch}`);
  const fetched = await git("fetch", "--prune", remote, `refs/heads/${branch}`);
  if (fetched.code !== 0)
    throw new BranchUnavailableError(
      fetched.stderr || `couldn't fetch ${remote}/${branch}`,
    );
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

/** Beta updates — Update branch `beta` (ADR-0018); флаг `iva.beta` — для прежних бета-сборок:
 * при main или без ветки уводит на beta, при своей ветке ставит её вершину. */
export const BETA_CONFIG = "iva.beta";
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** Включены ли бета-обновления; чужое значение — нет, и строка-предупреждение. */
async function readBeta(git: Git): Promise<boolean> {
  const value = output(await git("config", "--local", "--get", BETA_CONFIG));
  if (value && value !== "true" && value !== "false")
    console.warn(`⚠️ ${BETA_CONFIG}=${value}: not true, installing releases`);
  return value === "true";
}

/** Ставится ли вершина ветки: ветка beta или флаг iva.beta. */
export async function betaChannel(git: Git): Promise<boolean> {
  const branch = output(
    await git("config", "--local", "--get", UPDATE_BRANCH_CONFIG),
  );
  return (await readBeta(git)) || branch === BETA_BRANCH;
}

/** Цель не ниже установленного: назад обновление не ходит нигде; откат — только явный. */
async function notBelow(git: Git, target: string, installed?: string) {
  if (!installed || !target) return target;
  const found = await git(
    "rev-parse",
    "--verify",
    "-q",
    `${installed}^{commit}`,
  );
  // Активного коммита нет в зеркале: безопасность перехода не доказать — отказ.
  if (found.code !== 0)
    throw new Error(
      `the installed commit ${installed} is not in the mirror; nothing was installed`,
    );
  const at = output(found);
  if (at === target) return target;
  const older = await git("merge-base", "--is-ancestor", target, at);
  return older.code === 0 ? at : target;
}

type UpdateTarget = Awaited<ReturnType<typeof resolveUpdateTarget>>;

/** Бета-цель или null; прежний opt-in (флаг при main) переходит на beta один раз. */
async function betaTarget(
  git: Git,
  remote: string,
  resolved: UpdateTarget,
  installed?: string,
) {
  let target = resolved;
  const flag = await readBeta(git);
  if (flag && (!target.configured || target.branch === DEFAULT_UPDATE_BRANCH)) {
    const targetHead = await fetchBranch(git, remote, BETA_BRANCH);
    await persistUpdateBranch(git, BETA_BRANCH);
    target = { ...target, branch: BETA_BRANCH, configured: true, targetHead };
  }
  if (!flag && target.branch !== BETA_BRANCH) return null;
  const head = await notBelow(git, target.targetHead, installed);
  return { ...target, beta: true, targetHead: head };
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
  const remote = options.remote ?? "origin";
  const target = await resolveUpdateTarget(options);
  const beta = await betaTarget(git, remote, target, options.installed);
  if (beta) return beta;
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

/** Бета для показа (iva version, status, меню): ветка beta или флаг при main/без ветки. */
export function betaOf(root: string): boolean {
  const repo = gitRootFor(classifyRoot(root));
  const get = (key: string) =>
    spawnSync("git", ["-C", repo, "config", "--local", "--get", key], {
      encoding: "utf8",
    }).stdout?.trim() ?? "";
  const branch = get(UPDATE_BRANCH_CONFIG);
  const legacy = [DEFAULT_UPDATE_BRANCH, ""].includes(branch);
  return branch === BETA_BRANCH || (legacy && get(BETA_CONFIG) === "true");
}

/** iva beta / stable и меню: ветка и флаг во всех репозиториях установки. Любая запись не
 * прошла — прежние значения возвращаются везде, false. */
export function setBeta(root: string, on: boolean): boolean {
  const git = (repo: string, args: string[]) =>
    spawnSync("git", ["-C", repo, "config", "--local", ...args], {
      encoding: "utf8",
    });
  const keys = [UPDATE_BRANCH_CONFIG, BETA_CONFIG];
  const want = [on ? BETA_BRANCH : DEFAULT_UPDATE_BRANCH, on ? "true" : ""];
  const repos = betaRepos(root);
  const before = repos.map((repo) =>
    keys.map((key) => git(repo, ["--get", key]).stdout.trim()),
  );
  // Пусто — ключа нет: снять (код 5 — его и так не было).
  const put = (repo: string, key: string, value: string) =>
    [0, value ? 0 : 5].includes(
      git(repo, value ? [key, value] : ["--unset-all", key]).status!,
    );
  const ok = repos.every((repo) =>
    keys.every((key, k) => put(repo, key, want[k])),
  );
  if (!ok)
    repos.forEach((repo, r) =>
      keys.forEach((key, k) => put(repo, key, before[r][k])),
    );
  return repos.length > 0 && ok;
}
