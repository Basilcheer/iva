import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type ResourceIdentity = readonly [device: bigint, inode: bigint];

export type ResourceDirectoryLease = {
  readonly descriptor: number;
  readonly identity: ResourceIdentity;
  readonly tree: ResourceTreeProof;
  released: boolean;
};

export type ResourceTreeProof = {
  readonly digest: string;
  readonly entries: number;
  readonly bytes: bigint;
};

export type ResourceFileSnapshot = {
  identity: ResourceIdentity;
  mode: number;
  bytes: Buffer;
};

export type ResourceContainer = {
  path: string;
  lease: ResourceDirectoryLease;
};

export type ResourceIdentityHooks = {
  beforeQuarantineRename?(path: string): void;
};

function lstat(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function identity(stat: { dev: bigint; ino: bigint }): ResourceIdentity {
  return [stat.dev, stat.ino];
}

function sameIdentity(
  left: ResourceIdentity,
  right: ResourceIdentity,
): boolean {
  return left[0] === right[0] && left[1] === right[1];
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

function changed(label: string): never {
  throw new Error(`${label} ownership changed`);
}

function digestField(
  hash: ReturnType<typeof createHash>,
  value: string | Buffer,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function digestStat(
  hash: ReturnType<typeof createHash>,
  stat: {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  root: boolean,
): void {
  digestField(hash, (stat.mode & 0o7777n).toString());
  if (root) return;
  for (const value of [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ])
    digestField(hash, value.toString());
}

function captureDirectoryTree(path: string, label: string): ResourceTreeProof {
  const hash = createHash("sha256");
  const totals = { entries: 0, bytes: 0n };
  const chunk = Buffer.allocUnsafe(64 * 1024);

  function visit(current: string, relative: string, root: boolean): void {
    const before = lstat(current);
    if (!before) changed(label);
    totals.entries++;
    digestField(hash, relative);

    if (before.isDirectory() && !before.isSymbolicLink()) {
      digestField(hash, "directory");
      digestStat(hash, before, root);
      const names = readdirSync(current).sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      );
      for (const name of names)
        visit(
          join(current, name),
          relative ? join(relative, name) : name,
          false,
        );
      const after = lstat(current);
      if (!after || !sameInspection(before, after)) changed(label);
      return;
    }

    if (before.isFile() && !before.isSymbolicLink()) {
      digestField(hash, "file");
      const descriptor = openSync(
        current,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || !sameInspection(before, opened)) changed(label);
        digestStat(hash, opened, false);
        let fileBytes = 0n;
        for (;;) {
          const count = readSync(descriptor, chunk, 0, chunk.length, null);
          if (count === 0) break;
          hash.update(chunk.subarray(0, count));
          fileBytes += BigInt(count);
        }
        const finished = fstatSync(descriptor, { bigint: true });
        const after = lstat(current);
        if (
          fileBytes !== opened.size ||
          !after ||
          !sameInspection(opened, finished) ||
          !sameInspection(finished, after)
        )
          changed(label);
        totals.bytes += fileBytes;
      } finally {
        closeSync(descriptor);
      }
      return;
    }

    if (before.isSymbolicLink()) {
      digestField(hash, "symlink");
      digestStat(hash, before, false);
      const target = readlinkSync(current, { encoding: "buffer" });
      digestField(hash, target);
      const after = lstat(current);
      if (!after || !sameInspection(before, after)) changed(label);
      totals.bytes += BigInt(target.length);
      return;
    }

    throw new Error(`${label} contains an unsupported filesystem entry`);
  }

  visit(path, "", true);
  return { digest: hash.digest("hex"), ...totals };
}

export function pathMissing(path: string): boolean {
  return lstat(path) === null;
}

export function capturePathIdentity(
  path: string,
  label: string,
): ResourceIdentity {
  const stat = lstat(path);
  if (!stat) throw new Error(`${label} is missing`);
  return identity(stat);
}

export function captureDirectoryLease(
  path: string,
  label: string,
): ResourceDirectoryLease {
  const before = lstat(path);
  if (!before) throw new Error(`${label} is missing`);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error(`${label} is not a real directory`);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const after = lstat(path);
    if (
      !opened.isDirectory() ||
      !after ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameIdentity(identity(before), identity(opened)) ||
      !sameIdentity(identity(opened), identity(after))
    )
      changed(label);
    const tree = captureDirectoryTree(path, label);
    const finished = fstatSync(descriptor, { bigint: true });
    const final = lstat(path);
    if (
      !final ||
      !sameInspection(opened, finished) ||
      !sameInspection(finished, final)
    )
      changed(label);
    return {
      descriptor,
      identity: identity(opened),
      tree,
      released: false,
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function verifyDirectoryLease(
  path: string,
  expected: ResourceDirectoryLease,
  label: string,
): void {
  if (expected.released) changed(label);
  const held = fstatSync(expected.descriptor, { bigint: true });
  const actual = lstat(path);
  if (
    !held.isDirectory() ||
    !actual ||
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    !sameIdentity(identity(held), expected.identity) ||
    !sameIdentity(identity(actual), expected.identity)
  )
    changed(label);
}

export function verifyDirectoryTree(
  path: string,
  expected: ResourceDirectoryLease,
  label: string,
): void {
  verifyDirectoryLease(path, expected, label);
  const actual = captureDirectoryTree(path, label);
  verifyDirectoryLease(path, expected, label);
  if (
    actual.digest !== expected.tree.digest ||
    actual.entries !== expected.tree.entries ||
    actual.bytes !== expected.tree.bytes
  )
    changed(label);
}

export function releaseDirectoryLease(lease: ResourceDirectoryLease): void {
  if (lease.released) return;
  closeSync(lease.descriptor);
  lease.released = true;
}

export function captureStableFile(
  path: string,
  label: string,
): ResourceFileSnapshot {
  const before = lstat(path);
  if (!before) throw new Error(`${label} is missing`);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`${label} is not a real file`);
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameInspection(before, opened)) changed(label);
    const bytes = readFileSync(descriptor);
    const finished = fstatSync(descriptor, { bigint: true });
    const after = lstat(path);
    if (
      !after ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameInspection(opened, finished) ||
      !sameInspection(finished, after)
    )
      changed(label);
    return {
      identity: identity(after),
      mode: Number(after.mode & 0o777n),
      bytes,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function verifyStableFile(
  path: string,
  expected: ResourceFileSnapshot,
  label: string,
): void {
  const actual = captureStableFile(path, label);
  if (
    !sameIdentity(actual.identity, expected.identity) ||
    actual.mode !== expected.mode ||
    !actual.bytes.equals(expected.bytes)
  )
    changed(label);
}

export function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function syncParent(path: string): void {
  syncDirectory(dirname(path));
}

export function createOwnedContainer(
  parent: string,
  prefix: string,
): ResourceContainer {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = mkdtempSync(join(parent, prefix));
  chmodSync(path, 0o700);
  syncDirectory(path);
  syncDirectory(parent);
  return {
    path,
    lease: captureDirectoryLease(path, `${prefix} container`),
  };
}

export function writeExclusiveFile({
  path,
  bytes,
  mode,
  label,
}: {
  path: string;
  bytes: Buffer;
  mode: number;
  label: string;
}): ResourceFileSnapshot {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncParent(path);
  const snapshot = captureStableFile(path, label);
  if (snapshot.mode !== mode || !snapshot.bytes.equals(bytes)) changed(label);
  return snapshot;
}

export function moveOwnedDirectory({
  source,
  destination,
  expected,
  label,
}: {
  source: string;
  destination: string;
  expected: ResourceDirectoryLease;
  label: string;
}): void {
  verifyDirectoryLease(source, expected, label);
  if (!pathMissing(destination))
    throw new Error(`${label} destination already exists`);
  renameSync(source, destination);
  syncParent(source);
  if (dirname(source) !== dirname(destination)) syncParent(destination);
  verifyDirectoryLease(destination, expected, label);
}

function restoreUnexpectedMove({
  moved,
  original,
  container,
  movedIdentity,
  label,
}: {
  moved: string;
  original: string;
  container: ResourceContainer;
  movedIdentity: ResourceIdentity;
  label: string;
}): never {
  if (!pathMissing(original))
    throw new Error(`${label} ownership changed; replacement kept at ${moved}`);
  renameSync(moved, original);
  syncParent(original);
  const restored = capturePathIdentity(original, label);
  if (!sameIdentity(restored, movedIdentity)) changed(label);
  verifyDirectoryLease(container.path, container.lease, `${label} quarantine`);
  removeOwnedContainer(container);
  changed(label);
}

export function removeOwnedDirectory({
  path,
  expected,
  label,
  hooks = {},
}: {
  path: string;
  expected: ResourceDirectoryLease;
  label: string;
  hooks?: ResourceIdentityHooks;
}): void {
  verifyDirectoryLease(path, expected, label);
  hooks.beforeQuarantineRename?.(path);
  const parent = dirname(path);
  const quarantine = createOwnedContainer(
    parent,
    `.${basename(path)}.iva-remove-${process.pid}-${randomUUID()}-`,
  );
  const moved = join(quarantine.path, "owned");
  renameSync(path, moved);
  syncDirectory(parent);
  const movedIdentity = capturePathIdentity(moved, label);
  if (!sameIdentity(movedIdentity, expected.identity))
    restoreUnexpectedMove({
      moved,
      original: path,
      container: quarantine,
      movedIdentity,
      label,
    });
  verifyDirectoryLease(moved, expected, label);
  // This post-rename proof is the deletion linearization point. A mismatch restores
  // the entire tree; recursive removal never starts from a root-only identity check.
  try {
    verifyDirectoryTree(moved, expected, label);
  } catch {
    restoreUnexpectedMove({
      moved,
      original: path,
      container: quarantine,
      movedIdentity,
      label,
    });
  }
  verifyDirectoryLease(
    quarantine.path,
    quarantine.lease,
    `${label} quarantine`,
  );
  rmSync(moved, { recursive: true });
  releaseDirectoryLease(expected);
  rmdirSync(quarantine.path);
  syncDirectory(parent);
  releaseDirectoryLease(quarantine.lease);
}

export function removeOwnedFile({
  path,
  expected,
  label,
  hooks = {},
}: {
  path: string;
  expected: ResourceFileSnapshot;
  label: string;
  hooks?: ResourceIdentityHooks;
}): void {
  verifyStableFile(path, expected, label);
  hooks.beforeQuarantineRename?.(path);
  const parent = dirname(path);
  const quarantine = createOwnedContainer(
    parent,
    `.${basename(path)}.iva-remove-${process.pid}-${randomUUID()}-`,
  );
  const moved = join(quarantine.path, "owned");
  renameSync(path, moved);
  syncDirectory(parent);
  const movedIdentity = capturePathIdentity(moved, label);
  try {
    verifyStableFile(moved, expected, label);
  } catch {
    restoreUnexpectedMove({
      moved,
      original: path,
      container: quarantine,
      movedIdentity,
      label,
    });
  }
  verifyDirectoryLease(
    quarantine.path,
    quarantine.lease,
    `${label} quarantine`,
  );
  rmSync(moved);
  rmdirSync(quarantine.path);
  syncDirectory(parent);
  releaseDirectoryLease(quarantine.lease);
}

export function removeOwnedContainer(container: ResourceContainer): void {
  verifyDirectoryLease(container.path, container.lease, "backup container");
  rmdirSync(container.path);
  syncParent(container.path);
  releaseDirectoryLease(container.lease);
}
