import { lstatSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createRecoveryDirectory,
  createRecoveryLeaf,
  type RecoveryContentEntry,
  type RecoveryIdentity,
  type RecoveryIoHooks,
  ownershipChanged,
  recoveryLstat,
  safeRecoveryChild,
  syncRecoveryDirectory,
  verifyRecoveryDirectory,
  verifyRecoveryLeaf,
} from "./update-recovery-io.ts";
import {
  type SnapshotTreeEntry,
  type SnapshotUntrackedDirectoryEntry,
} from "./update-recovery-manifest.ts";

type RecoveryObjectGit = {
  runBuffer(args: string[]): Promise<{
    code: number;
    stdout: Buffer;
    stderr: string;
  }>;
};

type ExactIdentity = readonly [device: bigint, inode: bigint];

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathDepth(path: string): number {
  return path === "." ? 0 : path.split("/").length;
}

function parentPaths(path: string): string[] {
  const parents: string[] = [];
  let parent = dirname(path);
  for (;;) {
    parents.push(parent);
    if (parent === ".") return parents;
    parent = dirname(parent);
  }
}

function captureUntrackedDirectories({
  root,
  entries,
}: {
  root: string;
  entries: readonly SnapshotTreeEntry[];
}): SnapshotUntrackedDirectoryEntry[] {
  const leaves = new Set(entries.map(({ path }) => path));
  const candidates = new Set<string>();
  for (const path of leaves)
    for (const parent of parentPaths(path))
      if (parent !== ".") candidates.add(parent);

  const selected = new Map<string, SnapshotUntrackedDirectoryEntry>();
  const deepestFirst = [...candidates].sort(
    (left, right) =>
      pathDepth(right) - pathDepth(left) || comparePaths(left, right),
  );
  for (const path of deepestFirst) {
    const stat = recoveryLstat(root, path);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`unsupported untracked recovery directory: ${path}`);
    const children = readdirSync(safeRecoveryChild(root, path)).sort(
      comparePaths,
    );
    const complete = children.every((name) => {
      const child = `${path}/${name}`;
      return leaves.has(child) || selected.has(child);
    });
    if (!complete) continue;
    selected.set(path, {
      path,
      permissions: Number(stat.mode & 0o777n),
      children,
    });
  }
  return [...selected.values()].sort((left, right) =>
    comparePaths(left.path, right.path),
  );
}

export class RecoveryParentOwner {
  readonly #root: string;
  readonly #hooks: RecoveryIoHooks;
  readonly #identities = new Map<string, ExactIdentity>();
  readonly #mutableDirectories = new Set<string>();
  readonly #dirtyDirectories = new Set<string>();

  constructor({ root, hooks = {} }: { root: string; hooks?: RecoveryIoHooks }) {
    this.#root = root;
    this.#hooks = hooks;
  }

  capture(
    paths: readonly string[],
    mutableDirectories: readonly string[],
  ): void {
    for (const path of mutableDirectories) this.#mutableDirectories.add(path);
    for (const path of paths)
      for (const parent of parentPaths(path)) this.#capture(parent);
  }

  prove(path: string, { rebind = false }: { rebind?: boolean } = {}): void {
    for (const parent of parentPaths(path)) {
      const current = this.#readIdentity(parent);
      if (!current) {
        if (!rebind && this.#mutableDirectories.has(parent)) continue;
        return ownershipChanged(parent);
      }
      if (rebind && this.#mutableDirectories.has(parent)) continue;
      const expected = this.#identities.get(parent);
      if (!expected || current[0] !== expected[0] || current[1] !== expected[1])
        ownershipChanged(parent);
    }
  }

  bindDirectory(path: string): void {
    this.#identities.set(path, this.#identity(path));
  }

  rebindMutableDirectories(): void {
    for (const path of this.#mutableDirectories)
      this.#identities.set(path, this.#identity(path));
  }

  markChanged(path: string): void {
    this.#dirtyDirectories.add(dirname(path));
  }

  confirmDurability(): void {
    const deepestFirst = [...this.#dirtyDirectories].sort(
      (left, right) => pathDepth(right) - pathDepth(left),
    );
    for (const relative of deepestFirst) {
      const expected = this.#identity(relative);
      const path =
        relative === "."
          ? resolve(this.#root)
          : safeRecoveryChild(this.#root, relative);
      syncRecoveryDirectory(path, this.#hooks);
      const current = this.#identity(relative);
      if (current[0] !== expected[0] || current[1] !== expected[1])
        ownershipChanged(relative);
    }
    this.#dirtyDirectories.clear();
  }

  #capture(path: string): void {
    if (this.#identities.has(path)) return;
    this.#identities.set(path, this.#identity(path));
  }

  #identity(path: string): ExactIdentity {
    const identity = this.#readIdentity(path);
    return identity ?? ownershipChanged(path);
  }

  #readIdentity(path: string): ExactIdentity | null {
    const target =
      path === "." ? resolve(this.#root) : safeRecoveryChild(this.#root, path);
    try {
      const stat = lstatSync(target, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        return ownershipChanged(path);
      return [stat.dev, stat.ino];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  }
}

export class OriginalUntrackedOwner {
  readonly #root: string;
  readonly #git: RecoveryObjectGit;
  readonly #hooks: RecoveryIoHooks;
  readonly #identities = new Map<string, RecoveryIdentity>();
  readonly #parents: RecoveryParentOwner;

  constructor({
    root,
    git,
    hooks = {},
  }: {
    root: string;
    git: RecoveryObjectGit;
    hooks?: RecoveryIoHooks;
  }) {
    this.#root = root;
    this.#git = git;
    this.#hooks = hooks;
    this.#parents = new RecoveryParentOwner({ root, hooks });
  }

  captureDirectories(
    entries: readonly SnapshotTreeEntry[],
  ): SnapshotUntrackedDirectoryEntry[] {
    const directories = captureUntrackedDirectories({
      root: this.#root,
      entries,
    });
    for (const entry of entries) this.#captureLeafIdentity(entry.path);
    for (const entry of directories) this.#captureDirectoryIdentity(entry.path);
    this.#parents.capture(
      [...entries, ...directories].map(({ path }) => path),
      directories.map(({ path }) => path),
    );
    return directories;
  }

  bindSnapshot(
    entries: readonly SnapshotTreeEntry[],
    directories: readonly SnapshotUntrackedDirectoryEntry[],
  ): void {
    for (const { path } of [...entries, ...directories])
      if (!this.#identities.has(path))
        throw new Error(`untracked recovery identity is missing: ${path}`);
  }

  assertResetSafe(
    entries: readonly SnapshotTreeEntry[],
    directories: readonly SnapshotUntrackedDirectoryEntry[],
    currentIndexPaths: readonly string[],
  ): void {
    const protectedPaths = [
      ...entries.map(({ path }) => path),
      ...directories.map(({ path }) => path),
    ];
    const overlap = currentIndexPaths.find((path) =>
      protectedPaths.some(
        (protectedPath) =>
          path === protectedPath ||
          path.startsWith(`${protectedPath}/`) ||
          protectedPath.startsWith(`${path}/`),
      ),
    );
    if (overlap)
      throw new Error(
        `untracked recovery path overlaps the current index: ${overlap}`,
      );
  }

  async verify(
    entries: readonly SnapshotTreeEntry[],
    directories: readonly SnapshotUntrackedDirectoryEntry[],
    currentPaths: readonly string[],
    {
      rebind = false,
      requirePresent = rebind,
    }: { rebind?: boolean; requirePresent?: boolean } = {},
  ): Promise<void> {
    const currentOwnership = new Map<string, RecoveryIdentity>();
    for (const entry of await this.#contentEntries(entries)) {
      this.#parents.prove(entry.path, { rebind });
      const identity = verifyRecoveryLeaf({
        root: this.#root,
        entry,
        expectedIdentity: rebind
          ? null
          : (this.#identities.get(entry.path) ?? null),
        requirePresent,
      });
      this.#parents.prove(entry.path, { rebind });
      if (identity) currentOwnership.set(entry.path, identity);
    }
    for (const entry of directories) {
      this.#parents.prove(entry.path, { rebind });
      const identity = verifyRecoveryDirectory({
        root: this.#root,
        entry,
        expectedIdentity: rebind
          ? null
          : (this.#identities.get(entry.path) ?? null),
        requirePresent,
      });
      this.#parents.prove(entry.path, { rebind });
      if (identity) currentOwnership.set(entry.path, identity);
    }
    const expectedPaths = new Set(entries.map(({ path }) => path));
    const unexpected = currentPaths.find((path) => !expectedPaths.has(path));
    if (unexpected)
      throw new Error(
        `untracked recovery ownership changed: unexpected path ${unexpected}`,
      );
    if (rebind) {
      this.#identities.clear();
      for (const [path, identity] of currentOwnership)
        this.#identities.set(path, identity);
      this.#parents.rebindMutableDirectories();
    }
  }

  async restore(
    entries: readonly SnapshotTreeEntry[],
    directories: readonly SnapshotUntrackedDirectoryEntry[],
  ): Promise<void> {
    const shallowFirst = [...directories].sort(
      (left, right) => pathDepth(left.path) - pathDepth(right.path),
    );
    for (const entry of shallowFirst) this.#restoreDirectory(entry);
    for (const entry of await this.#contentEntries(entries))
      this.#restoreLeaf(entry);
    this.#parents.confirmDurability();
  }

  #restoreDirectory(entry: SnapshotUntrackedDirectoryEntry): void {
    if (recoveryLstat(this.#root, entry.path)) {
      this.#parents.prove(entry.path);
      verifyRecoveryDirectory({
        root: this.#root,
        entry,
        expectedIdentity: this.#identities.get(entry.path) ?? null,
        requirePresent: true,
      });
      this.#parents.prove(entry.path);
      return;
    }
    const identity = createRecoveryDirectory({
      root: this.#root,
      entry,
      proveParent: () => this.#parents.prove(entry.path),
      hooks: this.#hooks,
    });
    this.#identities.set(entry.path, identity);
    this.#parents.bindDirectory(entry.path);
    this.#parents.markChanged(entry.path);
  }

  #restoreLeaf(entry: RecoveryContentEntry): void {
    if (recoveryLstat(this.#root, entry.path)) {
      this.#parents.prove(entry.path);
      verifyRecoveryLeaf({
        root: this.#root,
        entry,
        expectedIdentity: this.#identities.get(entry.path) ?? null,
        requirePresent: true,
      });
      this.#parents.prove(entry.path);
      return;
    }
    const identity = createRecoveryLeaf({
      root: this.#root,
      entry,
      proveParent: () => this.#parents.prove(entry.path),
      hooks: this.#hooks,
    });
    this.#identities.set(entry.path, identity);
    this.#parents.markChanged(entry.path);
  }

  #captureLeafIdentity(path: string): void {
    const stat = recoveryLstat(this.#root, path);
    if (!stat) return ownershipChanged(path);
    this.#identities.set(path, [stat.dev, stat.ino]);
  }

  #captureDirectoryIdentity(path: string): void {
    const stat = recoveryLstat(this.#root, path);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
      return ownershipChanged(path);
    this.#identities.set(path, [stat.dev, stat.ino]);
  }

  async #contentEntries(
    entries: readonly SnapshotTreeEntry[],
  ): Promise<RecoveryContentEntry[]> {
    const content: RecoveryContentEntry[] = [];
    for (const entry of entries) {
      if (!entry.oid)
        throw new Error(
          `untracked recovery blob OID is missing: ${entry.path}`,
        );
      const blob = await this.#git.runBuffer(["cat-file", "blob", entry.oid]);
      if (blob.code !== 0)
        throw new Error(
          blob.stderr || `couldn't read untracked recovery blob: ${entry.path}`,
        );
      content.push({ ...entry, bytes: blob.stdout });
    }
    return content;
  }
}
