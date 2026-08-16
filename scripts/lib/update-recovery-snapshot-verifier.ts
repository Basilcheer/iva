import { verifyIgnoredCollisionDirectories } from "./update-ignored-collisions.ts";
import type { RecoveryGit } from "./update-recovery.ts";
import {
  type IndexFlags,
  metadataFor,
  type RecoverySnapshot,
  sameFlags,
  sameLiveEntries,
  sameStrings,
  sameTreeEntries,
  type SnapshotTreeEntry,
} from "./update-recovery-manifest.ts";
import type { RecoveryObjectStore } from "./update-recovery-objects.ts";

export const RECOVERY_METADATA_PREFIX = "iva-recovery-metadata-v1:";

export type CleanRecoveryState = {
  indexEntries: SnapshotTreeEntry[];
  indexTree: string;
  indexFlags: IndexFlags;
  worktreeEntries: SnapshotTreeEntry[];
  worktreeTree: string;
};

export class RecoverySnapshotVerifier {
  readonly #root: string;
  readonly #headOid: string;
  readonly #git: RecoveryGit;
  readonly #objects: RecoveryObjectStore;
  readonly #liveTrackedEntries: (
    entries: readonly SnapshotTreeEntry[],
  ) => SnapshotTreeEntry[];
  readonly #liveTreeEntry: (path: string) => SnapshotTreeEntry | null;
  readonly #liveBytes: (entry: SnapshotTreeEntry) => Buffer;
  readonly #indexFlags: () => Promise<IndexFlags>;
  readonly #untrackedPaths: () => Promise<string[]>;

  constructor({
    root,
    headOid,
    git,
    objects,
    liveTrackedEntries,
    liveTreeEntry,
    liveBytes,
    indexFlags,
    untrackedPaths,
  }: {
    root: string;
    headOid: string;
    git: RecoveryGit;
    objects: RecoveryObjectStore;
    liveTrackedEntries: (
      entries: readonly SnapshotTreeEntry[],
    ) => SnapshotTreeEntry[];
    liveTreeEntry: (path: string) => SnapshotTreeEntry | null;
    liveBytes: (entry: SnapshotTreeEntry) => Buffer;
    indexFlags: () => Promise<IndexFlags>;
    untrackedPaths: () => Promise<string[]>;
  }) {
    this.#root = root;
    this.#headOid = headOid;
    this.#git = git;
    this.#objects = objects;
    this.#liveTrackedEntries = liveTrackedEntries;
    this.#liveTreeEntry = liveTreeEntry;
    this.#liveBytes = liveBytes;
    this.#indexFlags = indexFlags;
    this.#untrackedPaths = untrackedPaths;
  }

  async verifySnapshot(
    snapshot: RecoverySnapshot,
    { verifyFlags }: { verifyFlags: boolean },
  ): Promise<void> {
    const [commitOid, baseOid, indexBaseOid, indexTree, snapshotIndexTree] =
      await Promise.all([
        this.#mustGit(["rev-parse", "--verify", `${snapshot.oid}^{commit}`]),
        this.#mustGit(["rev-parse", "--verify", `${snapshot.oid}^1`]),
        this.#mustGit(["rev-parse", "--verify", `${snapshot.oid}^2^1`]),
        this.#mustGit(["write-tree"]),
        this.#mustGit(["rev-parse", "--verify", `${snapshot.oid}^2^{tree}`]),
      ]);
    const snapshotWorktreeTree = await this.#mustGit([
      "rev-parse",
      "--verify",
      `${snapshot.oid}^{tree}`,
    ]);
    const worktreeTreeEntries = this.#objects.parseTreeEntries(
      await this.#mustGit(["ls-tree", "-r", "-z", snapshot.worktreeTree], true),
    );
    const currentWorktreeEntries = this.#liveTrackedEntries(
      snapshot.indexEntries,
    );
    const incomplete = [
      [commitOid !== snapshot.oid, "commit"],
      [baseOid !== this.#headOid, "base"],
      [indexBaseOid !== this.#headOid, "index-base"],
      [indexTree !== snapshotIndexTree, "index-tree"],
      [snapshotWorktreeTree !== snapshot.worktreeTree, "snapshot-tree"],
      [
        !sameTreeEntries(worktreeTreeEntries, snapshot.worktreeEntries),
        "snapshot-modes",
      ],
      [
        !sameTreeEntries(currentWorktreeEntries, snapshot.worktreeEntries),
        "live-modes",
      ],
    ]
      .filter(([failed]) => failed)
      .map(([, label]) => label);
    if (incomplete.length > 0)
      throw new Error(
        `git recovery snapshot is incomplete: ${incomplete.join(", ")}`,
      );
    await this.#verifyLiveBytes(worktreeTreeEntries, snapshot.worktreeEntries);

    if (snapshot.untrackedTree) {
      const snapshotUntrackedTree = await this.#mustGit([
        "rev-parse",
        "--verify",
        `${snapshot.oid}^3^{tree}`,
      ]);
      const untrackedTreeEntries = this.#objects.parseTreeEntries(
        await this.#mustGit(
          ["ls-tree", "-r", "-z", snapshot.untrackedTree],
          true,
        ),
      );
      const recoverableUntrackedEntries = [
        ...snapshot.untrackedEntries,
        ...snapshot.ignoredCollisionEntries,
      ];
      const currentUntrackedEntries = snapshot.untrackedEntries
        .map(({ path }) => this.#liveTreeEntry(path))
        .filter((entry): entry is SnapshotTreeEntry => entry !== null);
      if (
        snapshotUntrackedTree !== snapshot.untrackedTree ||
        !sameTreeEntries(untrackedTreeEntries, recoverableUntrackedEntries) ||
        !sameTreeEntries(currentUntrackedEntries, snapshot.untrackedEntries)
      )
        throw new Error("git recovery snapshot is incomplete: untracked-tree");
      await this.#verifyLiveBytes(
        untrackedTreeEntries,
        recoverableUntrackedEntries,
      );
    }
    verifyIgnoredCollisionDirectories(
      this.#root,
      snapshot.ignoredCollisionDirectories,
    );

    const message = await this.#mustGit([
      "show",
      "-s",
      "--format=%B",
      snapshot.oid,
    ]);
    const encoded = message
      .split("\n")
      .find((line) => line.startsWith(RECOVERY_METADATA_PREFIX))
      ?.slice(RECOVERY_METADATA_PREFIX.length);
    if (!encoded) throw new Error("git recovery snapshot metadata is missing");
    let storedMetadata: unknown;
    try {
      storedMetadata = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
    } catch {
      throw new Error("git recovery snapshot metadata is invalid");
    }
    if (
      JSON.stringify(storedMetadata) !== JSON.stringify(metadataFor(snapshot))
    )
      throw new Error("git recovery snapshot metadata does not match");
    if (verifyFlags) {
      const currentFlags = await this.#indexFlags();
      if (!sameFlags(currentFlags, snapshot.indexFlags))
        throw new Error("git recovery snapshot index flags do not match");
    }
    const currentUntracked = await this.#untrackedPaths();
    const expectedUntracked = snapshot.untrackedEntries.map(({ path }) => path);
    if (!sameStrings(currentUntracked, expectedUntracked))
      throw new Error("git recovery snapshot untracked paths do not match");
  }

  async verifyClean(state: CleanRecoveryState): Promise<void> {
    const [headOid, originalTree, indexTree, currentFlags, untrackedPaths] =
      await Promise.all([
        this.#mustGit(["rev-parse", "--verify", "HEAD"]),
        this.#mustGit(["rev-parse", "--verify", `${this.#headOid}^{tree}`]),
        this.#mustGit(["write-tree"]),
        this.#indexFlags(),
        this.#untrackedPaths(),
      ]);
    const worktreeEntries = this.#liveTrackedEntries(state.indexEntries);
    const worktree = await this.#objects.createRawTree(
      "verify-clean",
      worktreeEntries,
    );
    const incomplete = [
      [headOid !== this.#headOid, "head"],
      [indexTree !== state.indexTree || indexTree !== originalTree, "index"],
      [
        worktree.tree !== state.worktreeTree || worktree.tree !== indexTree,
        "worktree",
      ],
      [!sameLiveEntries(worktreeEntries, state.worktreeEntries), "modes"],
      [!sameFlags(currentFlags, state.indexFlags), "index-flags"],
      [untrackedPaths.length > 0, "untracked"],
    ]
      .filter(([failed]) => failed)
      .map(([, label]) => label);
    if (incomplete.length > 0)
      throw new Error(
        `clean recovery rollback is incomplete: ${incomplete.join(", ")}`,
      );
  }

  async #verifyLiveBytes(
    entries: readonly SnapshotTreeEntry[],
    expectedEntries: readonly SnapshotTreeEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      if (!entry.oid)
        throw new Error(`recovery blob OID is missing: ${entry.path}`);
      const blob = await this.#git.runBuffer(["cat-file", "blob", entry.oid]);
      if (blob.code !== 0)
        throw new Error(
          blob.stderr || `couldn't read recovery blob: ${entry.path}`,
        );
      const live = this.#liveBytes(entry);
      if (!blob.stdout.equals(live))
        throw new Error(
          `git recovery snapshot bytes do not match: ${entry.path}`,
        );
      const expected = expectedEntries.find(({ path }) => path === entry.path);
      const current = this.#liveTreeEntry(entry.path);
      if (current?.permissions !== expected?.permissions)
        throw new Error(
          `git recovery snapshot permissions do not match: ${entry.path}`,
        );
    }
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
