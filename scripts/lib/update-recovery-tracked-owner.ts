import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  createOwnedContainer,
  releaseDirectoryLease,
  syncDirectory,
  type ResourceFileSnapshot,
  verifyStableFile,
  writeExclusiveFile,
} from "./update-resource-identity.ts";
import {
  createRecoveryLeaf,
  type RecoveryContentEntry,
  type RecoveryIdentity,
  type RecoveryIoHooks,
  recoveryLstat,
  safeRecoveryChild,
  verifyRecoveryLeaf,
} from "./update-recovery-io.ts";

export type RawTrackedHooks = RecoveryIoHooks & {
  beforeRawTrackedRemoval?(path: string, boundary: "index" | "entry"): void;
  beforeRawTrackedReplace?(path: string): void;
  afterRawTrackedQuarantine?(path: string): void;
  afterRawTrackedPrepare?(path: string): void;
};

type MissingLease = { kind: "missing"; path: string };
type FileLease = {
  kind: "file";
  path: string;
  descriptor: number;
  snapshot: ResourceFileSnapshot;
};
type SymlinkLease = {
  kind: "symlink";
  path: string;
  entry: RecoveryContentEntry;
  identity: RecoveryIdentity;
};
type TrackedLease = MissingLease | FileLease | SymlinkLease;

function changed(path: string, debt?: string): never {
  throw new Error(
    `raw tracked recovery ownership changed: ${path}${debt ? `; replacement retained at ${debt}` : ""}`,
  );
}

function sameIdentity(
  left: readonly [bigint, bigint],
  right: readonly [bigint, bigint],
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function desiredMode(entry: RecoveryContentEntry): number {
  return entry.permissions ?? (entry.mode === "100755" ? 0o755 : 0o644);
}

function sameContents(
  lease: FileLease | SymlinkLease,
  desired: RecoveryContentEntry,
): boolean {
  if (lease.kind === "symlink")
    return desired.mode === "120000" && lease.entry.bytes.equals(desired.bytes);
  return (
    (desired.mode === "100644" || desired.mode === "100755") &&
    lease.snapshot.mode === desiredMode(desired) &&
    lease.snapshot.bytes.equals(desired.bytes)
  );
}

export class RawTrackedOwner {
  readonly #root: string;
  readonly #retentionRoot: string;
  readonly #hooks: RawTrackedHooks;
  readonly #leases = new Map<string, TrackedLease>();

  constructor({
    root,
    retentionRoot,
    hooks,
  }: {
    root: string;
    retentionRoot: string;
    hooks: RawTrackedHooks;
  }) {
    this.#root = root;
    this.#retentionRoot = retentionRoot;
    this.#hooks = hooks;
  }

  captureIndex(path: string): void {
    if (this.#leases.has(path)) return;
    const lease = this.#capture(path);
    this.#leases.set(path, lease);
    this.#hooks.beforeRawTrackedRemoval?.(
      safeRecoveryChild(this.#root, path),
      "index",
    );
    this.#verify(lease);
  }

  restore(entry: RecoveryContentEntry): void {
    const lease = this.#lease(entry.path);
    this.#hooks.beforeRawTrackedRemoval?.(
      safeRecoveryChild(this.#root, entry.path),
      "entry",
    );
    this.#verify(lease);
    if (lease.kind !== "missing" && sameContents(lease, entry)) return;
    if (lease.kind !== "missing") this.#quarantine(lease);
    this.#create(entry);
  }

  remove(path: string): void {
    const lease = this.#lease(path);
    this.#verify(lease);
    if (lease.kind !== "missing") this.#quarantine(lease);
  }

  release(path: string): void {
    const lease = this.#leases.get(path);
    if (!lease) return;
    if (lease.kind === "file") closeSync(lease.descriptor);
    this.#leases.delete(path);
  }

  close(): void {
    for (const lease of this.#leases.values())
      if (lease.kind === "file") closeSync(lease.descriptor);
    this.#leases.clear();
  }

  #lease(path: string): TrackedLease {
    const existing = this.#leases.get(path);
    if (existing) return existing;
    const captured = this.#capture(path);
    this.#leases.set(path, captured);
    return captured;
  }

  #capture(path: string): TrackedLease {
    const absolute = safeRecoveryChild(this.#root, path);
    const stat = recoveryLstat(this.#root, path);
    if (!stat) return { kind: "missing", path };
    if (stat.isFile() && !stat.isSymbolicLink()) {
      let descriptor: number | null = null;
      try {
        const snapshot = {
          identity: [stat.dev, stat.ino] as const,
          mode: Number(stat.mode & 0o777n),
          bytes: readFileSync(absolute),
        };
        verifyStableFile(absolute, snapshot, `raw tracked path ${path}`);
        descriptor = openSync(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const opened = fstatSync(descriptor, { bigint: true });
        if (!sameIdentity([opened.dev, opened.ino], snapshot.identity))
          return changed(path);
        verifyStableFile(absolute, snapshot, `raw tracked path ${path}`);
        return { kind: "file", path, descriptor, snapshot };
      } catch (error) {
        if (descriptor !== null) closeSync(descriptor);
        throw error;
      }
    }
    if (stat.isSymbolicLink()) {
      const entry: RecoveryContentEntry = {
        mode: "120000",
        path,
        bytes: readlinkSync(absolute, { encoding: "buffer" }),
      };
      const identity = verifyRecoveryLeaf({
        root: this.#root,
        entry,
        expectedIdentity: [stat.dev, stat.ino],
        requirePresent: true,
      });
      if (!identity) return changed(path);
      return { kind: "symlink", path, entry, identity };
    }
    return changed(path);
  }

  #verify(lease: TrackedLease): void {
    if (lease.kind === "missing") {
      if (recoveryLstat(this.#root, lease.path)) changed(lease.path);
      return;
    }
    if (lease.kind === "file") {
      const held = fstatSync(lease.descriptor, { bigint: true });
      if (!sameIdentity([held.dev, held.ino], lease.snapshot.identity))
        changed(lease.path);
      try {
        verifyStableFile(
          safeRecoveryChild(this.#root, lease.path),
          lease.snapshot,
          `raw tracked path ${lease.path}`,
        );
      } catch {
        changed(lease.path);
      }
      return;
    }
    try {
      verifyRecoveryLeaf({
        root: this.#root,
        entry: lease.entry,
        expectedIdentity: lease.identity,
        requirePresent: true,
      });
    } catch {
      changed(lease.path);
    }
  }

  #quarantine(lease: FileLease | SymlinkLease): void {
    this.#verify(lease);
    const absolute = safeRecoveryChild(this.#root, lease.path);
    const container = createOwnedContainer(
      this.#retentionRoot,
      `.${basename(lease.path)}.iva-raw-debt-`,
    );
    const moved = join(container.path, "owned");
    try {
      this.#hooks.beforeRawTrackedReplace?.(absolute);
      renameSync(absolute, moved);
      syncDirectory(dirname(absolute));
      syncDirectory(container.path);
      this.#hooks.afterRawTrackedQuarantine?.(moved);
      try {
        if (lease.kind === "file") {
          const held = fstatSync(lease.descriptor, { bigint: true });
          const movedStat = recoveryLstat(container.path, "owned");
          if (
            !movedStat ||
            !sameIdentity([held.dev, held.ino], lease.snapshot.identity) ||
            !sameIdentity(
              [movedStat.dev, movedStat.ino],
              lease.snapshot.identity,
            )
          )
            changed(lease.path, moved);
          verifyStableFile(
            moved,
            lease.snapshot,
            `raw tracked path ${lease.path}`,
          );
        } else {
          const movedEntry = { ...lease.entry, path: "owned" };
          verifyRecoveryLeaf({
            root: container.path,
            entry: movedEntry,
            expectedIdentity: lease.identity,
            requirePresent: true,
          });
        }
      } catch {
        changed(lease.path, moved);
      }
    } finally {
      releaseDirectoryLease(container.lease);
    }
  }

  #create(entry: RecoveryContentEntry): void {
    const absolute = safeRecoveryChild(this.#root, entry.path);
    mkdirSync(dirname(absolute), { recursive: true });
    if (entry.mode !== "120000") {
      this.#createFile(entry, absolute);
      return;
    }
    try {
      createRecoveryLeaf({
        root: this.#root,
        entry,
        proveParent: () => {},
        hooks: this.#hooks,
      });
      syncDirectory(dirname(absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        changed(entry.path);
      throw error;
    }
  }

  #createFile(entry: RecoveryContentEntry, absolute: string): void {
    if (entry.mode !== "100644" && entry.mode !== "100755")
      throw new Error(`unsupported recovery tree mode: ${entry.mode}`);
    this.#hooks.beforeCreate?.("file", entry.path);
    const container = createOwnedContainer(
      this.#retentionRoot,
      `.${basename(entry.path)}.iva-raw-publish-`,
    );
    const prepared = join(container.path, "owned");
    try {
      const snapshot = writeExclusiveFile({
        path: prepared,
        bytes: entry.bytes,
        mode: desiredMode(entry),
        label: `raw tracked prepared file ${entry.path}`,
      });
      this.#hooks.afterRawTrackedPrepare?.(prepared);
      try {
        verifyStableFile(
          prepared,
          snapshot,
          `raw tracked prepared file ${entry.path}`,
        );
        linkSync(prepared, absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          changed(entry.path, prepared);
        throw error;
      }
      this.#hooks.afterCreate?.("file", entry.path);
      syncDirectory(dirname(absolute));
      try {
        verifyStableFile(
          prepared,
          snapshot,
          `raw tracked prepared file ${entry.path}`,
        );
        verifyStableFile(
          absolute,
          snapshot,
          `raw tracked published file ${entry.path}`,
        );
      } catch {
        changed(entry.path, prepared);
      }
    } finally {
      releaseDirectoryLease(container.lease);
    }
  }
}
