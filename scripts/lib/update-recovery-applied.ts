import { type OriginalUntrackedOwner } from "./update-recovery-ownership.ts";
import { type RecoveryObjectStore } from "./update-recovery-objects.ts";
import {
  permissionOverrides,
  sameFlags,
  sameLiveEntries,
  type IndexFlags,
  type RecoverySnapshot,
  type SnapshotTreeEntry,
} from "./update-recovery-manifest.ts";

function ordinaryPermissions(mode: string): number | undefined {
  if (mode === "100755") return 0o755;
  if (mode === "100644") return 0o644;
  return undefined;
}

type AppliedStateGit = {
  run(
    args: string[],
    options?: { rawOutput?: boolean },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
};

export class AppliedRecoveryVerifier {
  readonly #git: AppliedStateGit;
  readonly #objects: RecoveryObjectStore;
  readonly #originalHead: string;
  readonly #untracked: OriginalUntrackedOwner;
  readonly #liveTrackedEntries: (
    entries: readonly SnapshotTreeEntry[],
  ) => SnapshotTreeEntry[];
  readonly #indexFlags: () => Promise<IndexFlags>;
  readonly #untrackedPaths: () => Promise<string[]>;

  constructor({
    git,
    objects,
    originalHead,
    untracked,
    liveTrackedEntries,
    indexFlags,
    untrackedPaths,
  }: {
    git: AppliedStateGit;
    objects: RecoveryObjectStore;
    originalHead: string;
    untracked: OriginalUntrackedOwner;
    liveTrackedEntries: (
      entries: readonly SnapshotTreeEntry[],
    ) => SnapshotTreeEntry[];
    indexFlags: () => Promise<IndexFlags>;
    untrackedPaths: () => Promise<string[]>;
  }) {
    this.#git = git;
    this.#objects = objects;
    this.#originalHead = originalHead;
    this.#untracked = untracked;
    this.#liveTrackedEntries = liveTrackedEntries;
    this.#indexFlags = indexFlags;
    this.#untrackedPaths = untrackedPaths;
  }

  async verify({
    snapshot,
    restoreStashOid,
    excludedUntrackedPaths,
  }: {
    snapshot: RecoverySnapshot;
    restoreStashOid: string;
    excludedUntrackedPaths: readonly string[];
  }): Promise<void> {
    if (
      snapshot.ignoredCollisionEntries.length > 0 ||
      snapshot.ignoredCollisionDirectories.length > 0
    )
      throw new Error("ignored recovery collisions are not fully resolved");
    const headOid = await this.#mustGit(["rev-parse", "--verify", "HEAD"]);
    const headTree = await this.#mustGit([
      "rev-parse",
      "--verify",
      `${headOid}^{tree}`,
    ]);
    const expectedIndexTree = restoreStashOid
      ? await this.#mergedTree(headOid, `${restoreStashOid}^2`)
      : headTree;
    const expectedWorktreeTree = restoreStashOid
      ? await this.#mergedTree(headOid, restoreStashOid)
      : headTree;
    const indexEntries = this.#objects.parseIndexEntries(
      await this.#mustGit(["ls-files", "--cached", "--stage", "-z"], true),
    );
    const indexTree = await this.#mustGit(["write-tree"]);
    const flags = await this.#indexFlags();
    const included = (path: string): boolean =>
      !excludedUntrackedPaths.some(
        (excluded) =>
          path === excluded ||
          path.startsWith(`${excluded}/`) ||
          excluded.startsWith(`${path}/`),
      );
    const untrackedEntries = snapshot.untrackedEntries.filter(({ path }) =>
      included(path),
    );
    const includedLeaves = untrackedEntries.map(({ path }) => path);
    const untrackedDirectories = snapshot.untrackedDirectories.filter(
      ({ path }) => includedLeaves.some((leaf) => leaf.startsWith(`${path}/`)),
    );
    await this.#untracked.verify(
      untrackedEntries,
      untrackedDirectories,
      (await this.#untrackedPaths()).filter(included),
      { requirePresent: true },
    );
    const finalHead = await this.#mustGit(["rev-parse", "--verify", "HEAD"]);
    const liveWorktreeEntries = this.#liveTrackedEntries(indexEntries);
    const worktree = await this.#objects.createRawTree(
      "verify-applied",
      liveWorktreeEntries,
    );
    const finalLiveWorktreeEntries = this.#liveTrackedEntries(indexEntries);
    const durablePermissions = permissionOverrides(snapshot.worktreeEntries);
    const permissionsMatch =
      sameLiveEntries(finalLiveWorktreeEntries, liveWorktreeEntries) &&
      finalLiveWorktreeEntries.every(
        ({ mode, path, permissions }) =>
          permissions ===
          (durablePermissions[path] ?? ordinaryPermissions(mode)),
      );
    const incomplete = [
      [indexTree !== expectedIndexTree, "index"],
      [worktree.tree !== expectedWorktreeTree, "worktree"],
      [!permissionsMatch, "worktree-permissions"],
      [!sameFlags(flags, snapshot.indexFlags), "index-flags"],
      [finalHead !== headOid, "head"],
    ]
      .filter(([failed]) => failed)
      .map(([, label]) => label);
    if (incomplete.length > 0)
      throw new Error(
        `applied recovery state is incomplete: ${incomplete.join(", ")}`,
      );
  }

  async #mergedTree(headOid: string, revision: string): Promise<string> {
    const tree = await this.#mustGit([
      "merge-tree",
      "--write-tree",
      "--no-messages",
      "--merge-base",
      this.#originalHead,
      headOid,
      revision,
    ]);
    if (!/^[0-9a-f]{40,64}$/u.test(tree))
      throw new Error("applied recovery merge did not produce one tree");
    return tree;
  }

  async #mustGit(args: string[], rawOutput = false): Promise<string> {
    const result = await this.#git.run(args, { rawOutput });
    if (result.code !== 0)
      throw new Error(
        result.stderr || result.stdout || `git ${args[0]} failed`,
      );
    return result.stdout;
  }
}
