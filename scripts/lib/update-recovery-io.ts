import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { type SnapshotTreeEntry } from "./update-recovery-manifest.ts";

export type RecoveryIdentity = readonly [device: bigint, inode: bigint];

export type RecoveryContentEntry = SnapshotTreeEntry & {
  bytes: Buffer;
};

export type RecoveryDirectoryEntry = {
  path: string;
  permissions: number;
  children?: readonly string[];
};

export type RecoveryCreateKind = "directory" | "file" | "symlink";

export type RecoveryIoHooks = {
  beforeCreate?(kind: RecoveryCreateKind, path: string): void;
  afterCreate?(kind: RecoveryCreateKind, path: string): void;
  syncDirectory?(path: string, sync: () => void): void;
};

export function ownershipChanged(path: string): never {
  throw new Error(`untracked recovery ownership changed: ${path}`);
}

export function safeRecoveryChild(root: string, relative: string): string {
  const base = resolve(root);
  const target = resolve(root, relative);
  if (target === base || !target.startsWith(`${base}${sep}`))
    throw new Error("unsafe path in update recovery data");
  return target;
}

export function recoveryLstat(root: string, path: string) {
  try {
    return lstatSync(safeRecoveryChild(root, path), { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function verifyIdentity(
  path: string,
  actual: RecoveryIdentity,
  expected: RecoveryIdentity | null,
): void {
  if (!expected || actual[0] !== expected[0] || actual[1] !== expected[1])
    ownershipChanged(path);
}

function sameInspection(
  left: {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  right: {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function verifyRecoveryLeaf({
  root,
  entry,
  expectedIdentity,
  requirePresent,
}: {
  root: string;
  entry: RecoveryContentEntry;
  expectedIdentity: RecoveryIdentity | null;
  requirePresent: boolean;
}): RecoveryIdentity | null {
  const stat = recoveryLstat(root, entry.path);
  if (!stat) return requirePresent ? ownershipChanged(entry.path) : null;
  const target = safeRecoveryChild(root, entry.path);
  const initialIdentity = [stat.dev, stat.ino] as const;
  if (expectedIdentity)
    verifyIdentity(entry.path, initialIdentity, expectedIdentity);
  let bytes: Buffer;
  let finalStat;
  if (entry.mode === "120000") {
    if (!stat.isSymbolicLink()) return ownershipChanged(entry.path);
    bytes = readlinkSync(target, { encoding: "buffer" });
    finalStat = recoveryLstat(root, entry.path);
    if (
      !finalStat ||
      !finalStat.isSymbolicLink() ||
      !sameInspection(stat, finalStat)
    )
      return ownershipChanged(entry.path);
  } else {
    if (!stat.isFile() || stat.isSymbolicLink())
      return ownershipChanged(entry.path);
    const descriptor = openSync(target, constants.O_RDONLY);
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!sameInspection(stat, opened)) return ownershipChanged(entry.path);
      bytes = readFileSync(descriptor);
      const finished = fstatSync(descriptor, { bigint: true });
      finalStat = recoveryLstat(root, entry.path);
      if (
        !sameInspection(opened, finished) ||
        !finalStat ||
        !finalStat.isFile() ||
        finalStat.isSymbolicLink() ||
        !sameInspection(finished, finalStat)
      )
        return ownershipChanged(entry.path);
    } finally {
      closeSync(descriptor);
    }
  }
  if (
    !bytes.equals(entry.bytes) ||
    (entry.permissions !== undefined &&
      Number(finalStat.mode & 0o777n) !== entry.permissions)
  )
    ownershipChanged(entry.path);
  return [finalStat.dev, finalStat.ino];
}

export function verifyRecoveryDirectory({
  root,
  entry,
  expectedIdentity,
  requirePresent,
}: {
  root: string;
  entry: RecoveryDirectoryEntry;
  expectedIdentity: RecoveryIdentity | null;
  requirePresent: boolean;
}): RecoveryIdentity | null {
  const stat = recoveryLstat(root, entry.path);
  if (!stat) return requirePresent ? ownershipChanged(entry.path) : null;
  const initialIdentity = [stat.dev, stat.ino] as const;
  if (expectedIdentity)
    verifyIdentity(entry.path, initialIdentity, expectedIdentity);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.mode & 0o777n) !== entry.permissions
  )
    return ownershipChanged(entry.path);
  if (entry.children) {
    const expectedChildren = new Set(entry.children);
    const children = readdirSync(safeRecoveryChild(root, entry.path));
    if (children.some((name) => !expectedChildren.has(name)))
      ownershipChanged(entry.path);
  }
  const finalStat = recoveryLstat(root, entry.path);
  if (
    !finalStat ||
    !finalStat.isDirectory() ||
    finalStat.isSymbolicLink() ||
    !sameInspection(stat, finalStat)
  )
    return ownershipChanged(entry.path);
  return [finalStat.dev, finalStat.ino];
}

function creationKind(entry: RecoveryContentEntry): RecoveryCreateKind {
  return entry.mode === "120000" ? "symlink" : "file";
}

export function createRecoveryDirectory({
  root,
  entry,
  proveParent,
  hooks,
}: {
  root: string;
  entry: RecoveryDirectoryEntry;
  proveParent: () => void;
  hooks: RecoveryIoHooks;
}): RecoveryIdentity {
  proveParent();
  hooks.beforeCreate?.("directory", entry.path);
  proveParent();
  const target = safeRecoveryChild(root, entry.path);
  try {
    mkdirSync(target, { mode: entry.permissions });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      ownershipChanged(entry.path);
    throw error;
  }
  const created = recoveryLstat(root, entry.path);
  if (!created || !created.isDirectory() || created.isSymbolicLink())
    return ownershipChanged(entry.path);
  const descriptor = openSync(
    target,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    hooks.afterCreate?.("directory", entry.path);
    proveParent();
    const live = recoveryLstat(root, entry.path);
    if (
      !live ||
      live.dev !== opened.dev ||
      live.ino !== opened.ino ||
      opened.dev !== created.dev ||
      opened.ino !== created.ino
    )
      return ownershipChanged(entry.path);
    fchmodSync(descriptor, entry.permissions);
    fsyncSync(descriptor);
    return [opened.dev, opened.ino];
  } finally {
    closeSync(descriptor);
  }
}

export function createRecoveryLeaf({
  root,
  entry,
  proveParent,
  hooks,
}: {
  root: string;
  entry: RecoveryContentEntry;
  proveParent: () => void;
  hooks: RecoveryIoHooks;
}): RecoveryIdentity {
  const kind = creationKind(entry);
  proveParent();
  hooks.beforeCreate?.(kind, entry.path);
  proveParent();
  const target = safeRecoveryChild(root, entry.path);
  try {
    if (entry.mode === "120000") {
      symlinkSync(entry.bytes, target);
      hooks.afterCreate?.(kind, entry.path);
      proveParent();
      const identity = verifyRecoveryLeaf({
        root,
        entry,
        expectedIdentity: null,
        requirePresent: true,
      });
      if (!identity) return ownershipChanged(entry.path);
      return identity;
    }
    if (entry.mode !== "100644" && entry.mode !== "100755")
      throw new Error(`unsupported recovery tree mode: ${entry.mode}`);
    const permissions =
      entry.permissions ?? (entry.mode === "100755" ? 0o755 : 0o644);
    const descriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      permissions,
    );
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      hooks.afterCreate?.(kind, entry.path);
      proveParent();
      const live = recoveryLstat(root, entry.path);
      if (!live || live.dev !== opened.dev || live.ino !== opened.ino)
        return ownershipChanged(entry.path);
      writeFileSync(descriptor, entry.bytes);
      fchmodSync(descriptor, permissions);
      fsyncSync(descriptor);
      return [opened.dev, opened.ino];
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      ownershipChanged(entry.path);
    throw error;
  }
}

export function syncRecoveryDirectory(
  path: string,
  hooks: RecoveryIoHooks,
): void {
  const sync = (): void => {
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };
  if (hooks.syncDirectory) hooks.syncDirectory(path, sync);
  else sync();
}
