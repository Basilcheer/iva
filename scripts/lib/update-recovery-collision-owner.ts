import type {
  IgnoredCollisionContentEntry,
  IgnoredCollisionDirectory,
  IgnoredCollisionEntry,
  IgnoredCollisionIdentity,
} from "./update-ignored-collisions.ts";
import { verifyIgnoredCollisionOwnership } from "./update-ignored-collisions.ts";
import {
  createRecoveryDirectory,
  createRecoveryLeaf,
  type RecoveryIoHooks,
  ownershipChanged,
  recoveryLstat,
  verifyRecoveryDirectory,
  verifyRecoveryLeaf,
} from "./update-recovery-io.ts";
import { RecoveryParentOwner } from "./update-recovery-ownership.ts";

type CollisionGit = {
  runBuffer(args: string[]): Promise<{
    code: number;
    stdout: Buffer;
    stderr: string;
  }>;
};

export class IgnoredCollisionOwner {
  readonly #root: string;
  readonly #git: CollisionGit;
  readonly #hooks: RecoveryIoHooks;
  readonly #parents: RecoveryParentOwner;
  #identities = new Map<string, IgnoredCollisionIdentity>();

  constructor({
    root,
    git,
    hooks = {},
  }: {
    root: string;
    git: CollisionGit;
    hooks?: RecoveryIoHooks;
  }) {
    this.#root = root;
    this.#git = git;
    this.#hooks = hooks;
    this.#parents = new RecoveryParentOwner({ root, hooks });
  }

  capture(
    entries: readonly IgnoredCollisionEntry[],
    directories: readonly IgnoredCollisionDirectory[],
  ): void {
    this.#parents.capture(
      [...entries, ...directories].map(({ path }) => path),
      directories.map(({ path }) => path),
    );
    this.#identities = new Map(
      [...entries, ...directories].map(({ path }) => {
        const stat = recoveryLstat(this.#root, path);
        if (!stat) return ownershipChanged(path);
        return [path, [stat.dev, stat.ino] as const];
      }),
    );
  }

  async verify(
    entries: readonly IgnoredCollisionEntry[],
    directories: readonly IgnoredCollisionDirectory[],
    { rebind = false }: { rebind?: boolean } = {},
  ): Promise<void> {
    const current = verifyIgnoredCollisionOwnership({
      root: this.#root,
      entries: await this.#content(entries),
      directories,
      ...(rebind ? {} : { identities: this.#identities }),
    });
    if (rebind) this.#identities = current;
  }

  verifyContent(entry: IgnoredCollisionContentEntry): void {
    verifyIgnoredCollisionOwnership({
      root: this.#root,
      entries: [entry],
      directories: [],
      identities: this.#identities,
    });
  }

  async restore(
    entries: readonly IgnoredCollisionEntry[],
    directories: readonly IgnoredCollisionDirectory[],
  ): Promise<void> {
    const shallowFirst = [...directories].sort(
      (left, right) =>
        left.path.split("/").length - right.path.split("/").length,
    );
    for (const entry of shallowFirst) this.#restoreDirectory(entry);
    for (const entry of await this.#content(entries)) this.#restoreLeaf(entry);
    this.#parents.confirmDurability();
  }

  #restoreDirectory(entry: IgnoredCollisionDirectory): void {
    this.#parents.prove(entry.path);
    if (recoveryLstat(this.#root, entry.path)) {
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

  #restoreLeaf(entry: IgnoredCollisionContentEntry): void {
    this.#parents.prove(entry.path);
    if (recoveryLstat(this.#root, entry.path)) {
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

  async #content(
    entries: readonly IgnoredCollisionEntry[],
  ): Promise<IgnoredCollisionContentEntry[]> {
    const content: IgnoredCollisionContentEntry[] = [];
    for (const entry of entries) {
      if (!("oid" in entry) || typeof entry.oid !== "string")
        throw new Error(`ignored recovery blob OID is missing: ${entry.path}`);
      const blob = await this.#git.runBuffer(["cat-file", "blob", entry.oid]);
      if (blob.code !== 0)
        throw new Error(
          blob.stderr || `couldn't read ignored recovery blob: ${entry.path}`,
        );
      content.push({ ...entry, bytes: blob.stdout });
    }
    return content;
  }
}
