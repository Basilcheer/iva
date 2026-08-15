import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  type IgnoredCollisionContentEntry,
  type IgnoredCollisionIdentity,
  planIgnoredCollisions,
  removeIgnoredCollisionPaths,
  restoreIgnoredCollisionDirectories,
  verifyIgnoredCollisionDirectories,
  verifyIgnoredCollisionOwnership,
  verifyIgnoredCollisionSet,
} from "./update-ignored-collisions.ts";
import {
  emptyFlags,
  type IndexFlags,
  metadataFor,
  permissionOverrides,
  type RecoverySnapshot,
  sameFlags,
  sameLiveEntries,
  sameStrings,
  sameTreeEntries,
  type SnapshotTreeEntry,
} from "./update-recovery-manifest.ts";

type CommandResult = { code: number; stdout: string; stderr: string };

export type RecoveryGit = {
  run(
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; input?: Buffer; rawOutput?: boolean },
  ): Promise<CommandResult>;
  runBuffer(args: string[]): Promise<{
    code: number;
    stdout: Buffer;
    stderr: string;
  }>;
};

export type RecoveryFileOps = {
  remove(path: string): void;
  removeCollisionLeaf?(path: string): void;
  removeEmptyDirectory?(path: string): void;
};

const DEFAULT_FILE_OPS: RecoveryFileOps = {
  remove(path) {
    rmSync(path, { recursive: true, force: true });
  },
};

type GuardState = {
  phase: "guard";
};

type CleanState = {
  phase: "clean";
  indexEntries: SnapshotTreeEntry[];
  indexTree: string;
  indexFlags: IndexFlags;
  worktreeEntries: SnapshotTreeEntry[];
  worktreeTree: string;
};

type SnapshotState = {
  phase: "snapshot";
  snapshot: RecoverySnapshot;
  restoreStashOid: string;
  disposition: "cleanup" | "retain";
};

type OwnerState = GuardState | CleanState | SnapshotState;

const RECOVERY_METADATA_PREFIX = "iva-recovery-metadata-v1:";

export class UpdateRecoveryOwner {
  readonly #root: string;
  readonly #headOid: string;
  readonly #ref: string;
  readonly #git: RecoveryGit;
  readonly #files: RecoveryFileOps;
  #collisionOwnership = new Map<string, IgnoredCollisionIdentity>();
  #state: OwnerState = { phase: "guard" };

  private constructor({
    root,
    headOid,
    ref,
    git,
    files,
  }: {
    root: string;
    headOid: string;
    ref: string;
    git: RecoveryGit;
    files: RecoveryFileOps;
  }) {
    this.#root = root;
    this.#headOid = headOid;
    this.#ref = ref;
    this.#git = git;
    this.#files = files;
  }

  static async create({
    root,
    headOid,
    git,
    files = DEFAULT_FILE_OPS,
  }: {
    root: string;
    headOid: string;
    git: RecoveryGit;
    files?: RecoveryFileOps;
  }): Promise<UpdateRecoveryOwner> {
    const ref = `refs/iva/update-recovery/${Date.now()}-${process.pid}-${randomUUID()}`;
    const owner = new UpdateRecoveryOwner({ root, headOid, ref, git, files });
    await owner.#mustGit(["update-ref", ref, headOid]);
    const durableOid = await owner.#mustGit([
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ]);
    if (durableOid !== headOid)
      throw new Error("durable recovery guard OID does not match");
    return owner;
  }

  get snapshotOid(): string {
    return this.#state.phase === "snapshot" ? this.#state.snapshot.oid : "";
  }

  get restoreStashOid(): string {
    return this.#state.phase === "snapshot" ? this.#state.restoreStashOid : "";
  }

  get recoveryOid(): string {
    return this.snapshotOid || this.#headOid;
  }

  get originalUntracked(): readonly string[] {
    return this.#state.phase === "snapshot"
      ? this.#state.snapshot.untrackedEntries.map(({ path }) => path)
      : [];
  }

  get ignoredCollisionPaths(): readonly string[] {
    if (this.#state.phase !== "snapshot") return [];
    return this.#state.snapshot.ignoredCollisionEntries.map(({ path }) => path);
  }

  get hasIgnoredCollisions(): boolean {
    return (
      this.#state.phase === "snapshot" &&
      (this.#state.snapshot.ignoredCollisionEntries.length > 0 ||
        this.#state.snapshot.ignoredCollisionDirectories.length > 0)
    );
  }

  async capture(
    message: string,
    {
      collisionTarget,
      excludedIgnoredRoots = [],
    }: {
      collisionTarget?: string;
      excludedIgnoredRoots?: readonly string[];
    } = {},
  ): Promise<{ dirty: boolean }> {
    if (this.#state.phase !== "guard")
      throw new Error("recovery owner already captured state");
    const indexEntries = this.#parseIndexEntries(
      await this.#mustGit(["ls-files", "--cached", "--stage", "-z"], true),
    );
    const indexFlags = await this.#indexFlags();
    const intentToAdd = await this.#intentToAddPaths();
    if (intentToAdd.length > 0)
      throw new Error(
        "intent-to-add index entries cannot be snapshotted safely",
      );
    const untrackedPaths = await this.#untrackedPaths();
    const indexTree = await this.#mustGit(["write-tree"]);
    const worktreeEntries = this.#liveTrackedEntries(indexEntries);
    const worktree = await this.#createRawTree("worktree", worktreeEntries);
    const ignoredCollisions = collisionTarget
      ? await planIgnoredCollisions({
          root: this.#root,
          targetOid: collisionTarget,
          indexPaths: indexEntries.map(({ path }) => path),
          untrackedPaths,
          excludedRoots: excludedIgnoredRoots,
          git: this.#git,
        })
      : { entries: [], directories: [], scopes: [] };
    const originalTree = await this.#mustGit([
      "rev-parse",
      "--verify",
      `${this.#headOid}^{tree}`,
    ]);
    const dirty =
      untrackedPaths.length > 0 ||
      indexFlags.assumeUnchanged.length > 0 ||
      indexFlags.skipWorktree.length > 0 ||
      indexTree !== originalTree ||
      worktree.tree !== indexTree ||
      ignoredCollisions.entries.length > 0 ||
      ignoredCollisions.directories.length > 0 ||
      Object.keys(permissionOverrides(worktreeEntries)).length > 0;
    if (!dirty) {
      this.#state = {
        phase: "clean",
        indexEntries,
        indexTree,
        indexFlags,
        worktreeEntries,
        worktreeTree: worktree.tree,
      };
      return { dirty: false };
    }

    const untrackedEntries = untrackedPaths.map((path) => {
      const entry = this.#liveTreeEntry(path);
      if (!entry)
        throw new Error(`untracked recovery path disappeared: ${path}`);
      return entry;
    });
    const recoverableUntrackedEntries = [
      ...untrackedEntries,
      ...ignoredCollisions.entries,
    ];
    const untracked =
      recoverableUntrackedEntries.length > 0
        ? await this.#createRawTree("untracked", recoverableUntrackedEntries)
        : null;
    const indexCommit = await this.#snapshotGit([
      "commit-tree",
      indexTree,
      "-p",
      this.#headOid,
      "-m",
      `${message} index`,
    ]);
    const untrackedCommit = untracked
      ? await this.#snapshotGit([
          "commit-tree",
          untracked.tree,
          "-m",
          `${message} untracked`,
        ])
      : null;
    const ignoredCollisionEntries = ignoredCollisions.entries.map((entry) => {
      const oid = untracked?.entries.find(
        ({ path }) => path === entry.path,
      )?.oid;
      if (!oid)
        throw new Error(`ignored recovery blob OID is missing: ${entry.path}`);
      return { ...entry, oid };
    });
    const provisional: RecoverySnapshot = {
      oid: "",
      indexTree,
      worktreeTree: worktree.tree,
      untrackedTree: untracked?.tree ?? null,
      indexEntries,
      worktreeEntries,
      untrackedEntries,
      ignoredCollisionEntries,
      ignoredCollisionDirectories: ignoredCollisions.directories,
      ignoredCollisionScopes: ignoredCollisions.scopes,
      indexFlags,
    };
    const metadata = Buffer.from(
      JSON.stringify(metadataFor(provisional)),
    ).toString("base64url");
    const oid = await this.#snapshotGit([
      "commit-tree",
      worktree.tree,
      "-p",
      this.#headOid,
      "-p",
      indexCommit,
      ...(untrackedCommit ? ["-p", untrackedCommit] : []),
      "-m",
      message,
      "-m",
      `${RECOVERY_METADATA_PREFIX}${metadata}`,
    ]);
    const snapshot = { ...provisional, oid };
    await this.#verifySnapshot(snapshot, { verifyFlags: true });
    await this.#mustGit(["update-ref", this.#ref, oid, this.#headOid]);
    const durableOid = await this.#mustGit([
      "rev-parse",
      "--verify",
      `${this.#ref}^{commit}`,
    ]);
    if (durableOid !== oid)
      throw new Error("durable recovery snapshot OID does not match");
    this.#state = {
      phase: "snapshot",
      snapshot,
      restoreStashOid: "",
      disposition: "cleanup",
    };
    this.#collisionOwnership = new Map(
      [
        ...snapshot.ignoredCollisionEntries,
        ...snapshot.ignoredCollisionDirectories,
      ].map(({ path, device, inode }) => [path, [device, inode] as const]),
    );
    return { dirty: true };
  }

  async storeSnapshot(message: string): Promise<void> {
    const state = this.#snapshotState();
    const stored = await this.#git.run([
      "stash",
      "store",
      "--message",
      message,
      state.snapshot.oid,
    ]);
    if (stored.code !== 0)
      throw new Error(
        stored.stderr || stored.stdout || "git stash store failed",
      );
  }

  setRestoreStashOid(oid: string): void {
    const state = this.#snapshotState();
    this.#state = { ...state, restoreStashOid: oid };
  }

  retain(): void {
    const state = this.#snapshotState();
    this.#state = { ...state, disposition: "retain" };
  }

  async prepareLiveTree(): Promise<void> {
    const state = this.#snapshotState();
    await this.#verifySnapshot(state.snapshot, { verifyFlags: true });
    await this.#verifyIgnoredCollisionOwnership(state.snapshot);
    await this.#restoreSnapshot(state.snapshot, {
      preserveCollisionOwnership: true,
      restoreFlags: false,
    });
  }

  async rollback(): Promise<void> {
    if (this.#state.phase === "guard") return;
    if (this.#state.phase === "clean") {
      await this.#clearIndexFlags(this.#state.indexFlags);
      await this.#mustGit(["reset", "--hard", this.#headOid]);
      await this.#restoreIndexFlags(this.#state.indexFlags);
      await this.#verifyClean(this.#state);
      return;
    }
    await this.#restoreSnapshot(this.#state.snapshot, {
      preserveCollisionOwnership: false,
      restoreFlags: true,
    });
  }

  async restoreFlagsForCurrentIndex(): Promise<void> {
    if (this.#state.phase === "guard") return;
    const flags =
      this.#state.phase === "clean"
        ? this.#state.indexFlags
        : this.#state.snapshot.indexFlags;
    await this.#restoreIndexFlags(flags);
  }

  removeOriginalUntracked(base = this.#root): void {
    for (const relative of this.originalUntracked)
      this.#files.remove(this.#safeChild(base, relative));
  }

  async removeIgnoredCollisions(): Promise<void> {
    const state = this.#snapshotState();
    await this.#verifyIgnoredCollisionOwnership(state.snapshot);
    await verifyIgnoredCollisionSet({
      git: this.#git,
      scopes: state.snapshot.ignoredCollisionScopes,
      entries: state.snapshot.ignoredCollisionEntries,
    });
    const removableScopes = state.snapshot.ignoredCollisionScopes.filter(
      (scope) =>
        !state.snapshot.indexEntries.some(
          ({ path }) => path === scope || path.startsWith(`${scope}/`),
        ),
    );
    removeIgnoredCollisionPaths({
      root: this.#root,
      entries: state.snapshot.ignoredCollisionEntries,
      directories: state.snapshot.ignoredCollisionDirectories,
      scopes: removableScopes,
      ...(this.#files.removeCollisionLeaf
        ? { remove: (path: string) => this.#files.removeCollisionLeaf?.(path) }
        : {}),
      ...(this.#files.removeEmptyDirectory
        ? {
            removeDirectory: (path: string) =>
              this.#files.removeEmptyDirectory?.(path),
          }
        : {}),
    });
  }

  async cleanup(dropExactStash: (oid: string) => Promise<void>): Promise<void> {
    if (
      this.#state.phase === "snapshot" &&
      this.#state.disposition === "retain"
    )
      return;
    const owned = await this.#git.run(["rev-parse", "--verify", this.#ref]);
    if (owned.code !== 0 || owned.stdout !== this.recoveryOid)
      throw new Error(
        owned.stderr || "recovery ref no longer points to the owned OID",
      );
    if (this.#state.phase === "snapshot") {
      await dropExactStash(this.#state.restoreStashOid);
      await dropExactStash(this.#state.snapshot.oid);
    }
    const deleted = await this.#git.run([
      "update-ref",
      "-d",
      this.#ref,
      this.recoveryOid,
    ]);
    if (deleted.code !== 0)
      throw new Error(
        deleted.stderr || deleted.stdout || "recovery ref cleanup failed",
      );
    const remaining = await this.#git.run([
      "rev-parse",
      "--verify",
      "--quiet",
      this.#ref,
    ]);
    if (remaining.code === 0)
      throw new Error("recovery ref cleanup did not remove the owned ref");
    if (remaining.stderr) throw new Error(remaining.stderr);
  }

  async #restoreSnapshot(
    snapshot: RecoverySnapshot,
    {
      preserveCollisionOwnership,
      restoreFlags,
    }: { preserveCollisionOwnership: boolean; restoreFlags: boolean },
  ): Promise<void> {
    await this.#clearIndexFlags(snapshot.indexFlags);
    await this.#mustGit(["reset", "--hard", this.#headOid]);
    this.removeOriginalUntracked();
    await this.#mustGit(["read-tree", snapshot.indexTree]);
    await this.#materializeTree(
      snapshot.worktreeTree,
      snapshot.indexEntries.map(({ path }) => path),
    );
    if (snapshot.untrackedTree)
      await this.#materializeTree(
        snapshot.untrackedTree,
        [],
        preserveCollisionOwnership,
      );
    if (!preserveCollisionOwnership)
      restoreIgnoredCollisionDirectories(
        this.#root,
        snapshot.ignoredCollisionDirectories,
      );
    if (restoreFlags) await this.#restoreIndexFlags(snapshot.indexFlags);
    await this.#verifySnapshot(snapshot, { verifyFlags: restoreFlags });
    if (!preserveCollisionOwnership)
      this.#collisionOwnership = await this.#verifyIgnoredCollisionOwnership(
        snapshot,
        true,
      );
  }

  async #verifySnapshot(
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
    const worktreeTreeEntries = this.#parseTreeEntries(
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
      const untrackedTreeEntries = this.#parseTreeEntries(
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

  async #verifyClean(state: CleanState): Promise<void> {
    const [headOid, originalTree, indexTree, currentFlags, untrackedPaths] =
      await Promise.all([
        this.#mustGit(["rev-parse", "--verify", "HEAD"]),
        this.#mustGit(["rev-parse", "--verify", `${this.#headOid}^{tree}`]),
        this.#mustGit(["write-tree"]),
        this.#indexFlags(),
        this.#untrackedPaths(),
      ]);
    const worktreeEntries = this.#liveTrackedEntries(state.indexEntries);
    const worktree = await this.#createRawTree("verify-clean", worktreeEntries);
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

  async #verifyIgnoredCollisionOwnership(
    snapshot: RecoverySnapshot,
    rebind = false,
  ): Promise<Map<string, IgnoredCollisionIdentity>> {
    const entries: IgnoredCollisionContentEntry[] = [];
    for (const entry of snapshot.ignoredCollisionEntries) {
      const blob = await this.#git.runBuffer(["cat-file", "blob", entry.oid]);
      if (blob.code !== 0)
        throw new Error(
          blob.stderr || `couldn't read ignored recovery blob: ${entry.path}`,
        );
      entries.push({
        ...entry,
        bytes: blob.stdout,
        device: entry.device,
        inode: entry.inode,
      });
    }
    return verifyIgnoredCollisionOwnership({
      root: this.#root,
      entries,
      directories: snapshot.ignoredCollisionDirectories,
      ...(rebind ? {} : { identities: this.#collisionOwnership }),
    });
  }

  async #materializeTree(
    tree: string,
    removePaths: readonly string[],
    preserveCollisionOwnership = false,
  ) {
    const entries = this.#parseTreeEntries(
      await this.#mustGit(["ls-tree", "-r", "-z", tree]),
    );
    for (const path of removePaths)
      this.#files.remove(this.#safeChild(this.#root, path));
    for (const entry of entries) {
      if (!entry.oid)
        throw new Error(`recovery blob OID is missing: ${entry.path}`);
      const blob = await this.#git.runBuffer(["cat-file", "blob", entry.oid]);
      if (blob.code !== 0)
        throw new Error(
          blob.stderr || `couldn't read recovery blob: ${entry.path}`,
        );
      const collision = preserveCollisionOwnership
        ? this.#snapshotState().snapshot.ignoredCollisionEntries.find(
            ({ path }) => path === entry.path,
          )
        : undefined;
      if (collision) {
        verifyIgnoredCollisionOwnership({
          root: this.#root,
          entries: [
            {
              ...collision,
              bytes: blob.stdout,
              device: collision.device,
              inode: collision.inode,
            },
          ],
          directories: [],
          identities: this.#collisionOwnership,
        });
        continue;
      }
      const target = this.#safeChild(this.#root, entry.path);
      this.#files.remove(target);
      mkdirSync(dirname(target), { recursive: true });
      if (entry.mode === "120000") {
        symlinkSync(blob.stdout, target);
      } else if (entry.mode === "100644" || entry.mode === "100755") {
        const expected =
          this.#state.phase === "snapshot"
            ? [
                ...this.#state.snapshot.worktreeEntries,
                ...this.#state.snapshot.untrackedEntries,
                ...this.#state.snapshot.ignoredCollisionEntries,
              ].find(({ path }) => path === entry.path)
            : undefined;
        const permissions =
          expected?.permissions ?? (entry.mode === "100755" ? 0o755 : 0o644);
        writeFileSync(target, blob.stdout, { mode: permissions });
        chmodSync(target, permissions);
      } else {
        throw new Error(`unsupported recovery tree mode: ${entry.mode}`);
      }
    }
  }

  async #createRawTree(
    name: string,
    entries: readonly SnapshotTreeEntry[],
  ): Promise<{ tree: string; entries: SnapshotTreeEntry[] }> {
    const snapshotDir = mkdtempSync(
      join(tmpdir(), `iva-update-${name}-snapshot-`),
    );
    const indexEnv = { GIT_INDEX_FILE: join(snapshotDir, "index") };
    try {
      await this.#snapshotGit(["read-tree", "--empty"], indexEnv);
      const resolved: SnapshotTreeEntry[] = [];
      for (const entry of entries) {
        let oid: string;
        if (entry.mode === "120000") {
          oid = await this.#snapshotGit(
            ["hash-object", "-w", "--stdin"],
            {},
            this.#liveBytes(entry),
          );
        } else if (entry.mode === "100644" || entry.mode === "100755") {
          oid = await this.#snapshotGit([
            "hash-object",
            "-w",
            "--no-filters",
            "--",
            entry.path,
          ]);
        } else {
          throw new Error(`unsupported working-tree mode: ${entry.mode}`);
        }
        resolved.push({ ...entry, oid });
      }
      if (resolved.length > 0) {
        const input = Buffer.concat(
          resolved.map(({ mode, oid, path }) =>
            Buffer.from(`${mode} ${oid}\t${path}\0`),
          ),
        );
        await this.#snapshotGit(
          ["update-index", "-z", "--index-info"],
          indexEnv,
          input,
        );
      }
      const tree = await this.#snapshotGit(["write-tree"], indexEnv);
      return { tree, entries: resolved };
    } finally {
      this.#files.remove(snapshotDir);
    }
  }

  #parseIndexEntries(text: string): SnapshotTreeEntry[] {
    return text
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf("\t");
        const [mode, oid, stage] = record.slice(0, tab).split(" ");
        if (tab < 0 || !mode || !oid || stage !== "0")
          throw new Error("the Git index cannot be snapshotted");
        return { mode, oid, path: record.slice(tab + 1) };
      });
  }

  #parseTreeEntries(text: string): SnapshotTreeEntry[] {
    return text
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf("\t");
        const [mode, , oid] = record.slice(0, tab).split(" ");
        if (tab < 0 || !mode || !oid)
          throw new Error("the recovery tree cannot be verified");
        return { mode, oid, path: record.slice(tab + 1) };
      });
  }

  #parseIndexFlags(text: string): IndexFlags {
    const flags = emptyFlags();
    for (const record of text.split("\0").filter(Boolean)) {
      if (record.length < 3 || record[1] !== " ")
        throw new Error("the Git index flags cannot be snapshotted");
      const tag = record[0] ?? "";
      const path = record.slice(2);
      if (tag !== tag.toUpperCase()) flags.assumeUnchanged.push(path);
      if (tag.toUpperCase() === "S") flags.skipWorktree.push(path);
    }
    return flags;
  }

  async #indexFlags(): Promise<IndexFlags> {
    return this.#parseIndexFlags(
      await this.#mustGit(["ls-files", "-v", "-z"], true),
    );
  }

  async #intentToAddPaths(): Promise<string[]> {
    const [ordinary, visible] = await Promise.all([
      this.#mustGit(["diff", "--cached", "--name-only", "-z"], true),
      this.#mustGit(
        ["diff", "--cached", "--name-only", "-z", "--ita-visible-in-index"],
        true,
      ),
    ]);
    const ordinaryPaths = new Set(ordinary.split("\0").filter(Boolean));
    return visible
      .split("\0")
      .filter((path) => path && !ordinaryPaths.has(path));
  }

  async #untrackedPaths(): Promise<string[]> {
    return (
      await this.#mustGit(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        true,
      )
    )
      .split("\0")
      .filter(Boolean);
  }

  #liveTrackedEntries(
    indexEntries: readonly SnapshotTreeEntry[],
  ): SnapshotTreeEntry[] {
    return indexEntries
      .map(({ mode, path }) => this.#liveTreeEntry(path, mode))
      .filter((entry): entry is SnapshotTreeEntry => entry !== null);
  }

  #liveTreeEntry(path: string, indexMode?: string): SnapshotTreeEntry | null {
    let stat;
    try {
      stat = lstatSync(this.#safeChild(this.#root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return { mode: "120000", path };
    if (stat.isFile())
      return {
        mode: stat.mode & 0o111 ? "100755" : "100644",
        path,
        permissions: stat.mode & 0o777,
      };
    if (stat.isDirectory() && indexMode === "160000")
      throw new Error(`unsupported working-tree entry: ${path} (gitlink)`);
    throw new Error(`unsupported working-tree entry: ${path}`);
  }

  #liveBytes(entry: SnapshotTreeEntry): Buffer {
    const path = this.#safeChild(this.#root, entry.path);
    if (entry.mode === "120000")
      return readlinkSync(path, { encoding: "buffer" });
    if (entry.mode === "100644" || entry.mode === "100755")
      return readFileSync(path);
    throw new Error(`unsupported working-tree mode: ${entry.mode}`);
  }

  async #clearIndexFlags(flags: IndexFlags): Promise<void> {
    for (const path of flags.assumeUnchanged)
      await this.#mustGit([
        "--literal-pathspecs",
        "update-index",
        "--no-assume-unchanged",
        "--",
        path,
      ]);
    for (const path of flags.skipWorktree)
      await this.#mustGit([
        "--literal-pathspecs",
        "update-index",
        "--no-skip-worktree",
        "--",
        path,
      ]);
  }

  async #restoreIndexFlags(flags: IndexFlags): Promise<void> {
    for (const path of flags.assumeUnchanged)
      await this.#mustGit([
        "--literal-pathspecs",
        "update-index",
        "--assume-unchanged",
        "--",
        path,
      ]);
    for (const path of flags.skipWorktree)
      await this.#mustGit([
        "--literal-pathspecs",
        "update-index",
        "--skip-worktree",
        "--",
        path,
      ]);
  }

  #safeChild(base: string, ...parts: string[]): string {
    const basePath = resolve(base);
    const target = resolve(base, ...parts);
    if (target !== basePath && !target.startsWith(`${basePath}${sep}`))
      throw new Error("unsafe path in update recovery data");
    return target;
  }

  #snapshotState(): SnapshotState {
    if (this.#state.phase !== "snapshot")
      throw new Error("a complete recovery snapshot is required");
    return this.#state;
  }

  async #snapshotGit(
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
    input?: Buffer,
  ): Promise<string> {
    const result = await this.#git.run(args, {
      env: {
        GIT_AUTHOR_NAME: "Iva Update Recovery",
        GIT_AUTHOR_EMAIL: "iva-update@localhost",
        GIT_COMMITTER_NAME: "Iva Update Recovery",
        GIT_COMMITTER_EMAIL: "iva-update@localhost",
        ...extraEnv,
      },
      ...(input ? { input } : {}),
    });
    if (result.code !== 0)
      throw new Error(
        result.stderr || result.stdout || `git ${args[0]} failed`,
      );
    return result.stdout;
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
