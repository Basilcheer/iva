import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  gitAt,
  packageVersion,
  requireGit,
  type GitCommand,
} from "./update-check.ts";
import { resolveUpdateTarget } from "./update-channel.ts";

export type Target = { readonly sha: string; readonly version: string };

/**
 * A bare mirror of the repository, cloned from the checkout being converted.
 * Nothing runs from it, so an update can rewrite it freely and needs no network
 * to create it.
 */
export async function ensureMirror({
  home,
  checkout,
  git = gitAt,
}: {
  home: string;
  checkout: string;
  git?: GitCommand;
}): Promise<string> {
  const repo = join(home, "repo");
  if (existsSync(repo)) return repo;
  const staging = `${repo}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    await requireGit(git, home, [
      "clone",
      "--mirror",
      join(checkout, ".git"),
      staging,
    ]);
    const origin = await requireGit(git, checkout, [
      "remote",
      "get-url",
      "origin",
    ]);
    await requireGit(git, staging, ["remote", "set-url", "origin", origin]);
    const branch = await git(checkout, [
      "config",
      "--local",
      "--get",
      "iva.updateBranch",
    ]);
    const configured =
      typeof branch === "string" ? branch.trim() : (branch.stdout ?? "").trim();
    if (configured)
      await requireGit(git, staging, [
        "config",
        "iva.updateBranch",
        configured,
      ]);
    renameSync(staging, repo);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return repo;
}

/**
 * What the next version should be built from. An unreachable remote is not a
 * failure: the newest commit already mirrored is the honest answer, which turns
 * an offline update into a no-op rather than an error.
 */
export async function resolveTarget({
  repo,
  git = gitAt,
}: {
  repo: string;
  git?: GitCommand;
}): Promise<Target> {
  let sha: string | undefined;
  try {
    const target = await resolveUpdateTarget({
      git: (...args) => {
        const result = git(repo, args);
        return Promise.resolve(result).then((value) =>
          typeof value === "string" ? { code: 0, stdout: value } : value,
        );
      },
    });
    sha = target.targetHead;
  } catch {
    // Offline, or a remote that refuses the fetch.
  }
  if (!sha) sha = await requireGit(git, repo, ["rev-parse", "HEAD"]);
  const version = packageVersion(
    await requireGit(git, repo, ["show", `${sha}:package.json`]),
  );
  if (!version) throw new Error(`no package version at ${sha}`);
  return { sha, version };
}
