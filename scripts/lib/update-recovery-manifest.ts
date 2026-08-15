export type SnapshotTreeEntry = {
  mode: string;
  oid?: string;
  path: string;
  permissions?: number;
  device?: number;
  inode?: number;
};

type SnapshotIgnoredCollisionEntry = Omit<
  SnapshotTreeEntry,
  "device" | "inode" | "oid"
> & {
  device: number;
  inode: number;
  oid: string;
};

export type SnapshotDirectoryEntry = {
  path: string;
  permissions: number;
  device: number;
  inode: number;
};

export type IndexFlags = {
  assumeUnchanged: string[];
  skipWorktree: string[];
};

export type RecoverySnapshot = {
  oid: string;
  indexTree: string;
  worktreeTree: string;
  untrackedTree: string | null;
  indexEntries: SnapshotTreeEntry[];
  worktreeEntries: SnapshotTreeEntry[];
  untrackedEntries: SnapshotTreeEntry[];
  ignoredCollisionEntries: SnapshotIgnoredCollisionEntry[];
  ignoredCollisionDirectories: SnapshotDirectoryEntry[];
  ignoredCollisionScopes: string[];
  indexFlags: IndexFlags;
};

type RecoveryMetadata = {
  schema: "iva-update-recovery/v1";
  indexFlags: IndexFlags;
  worktreePermissions: Record<string, number>;
  untrackedPermissions: Record<string, number>;
  ignoredCollisionPaths: string[];
  ignoredCollisionDirectories: Record<string, number>;
  ignoredCollisionScopes: string[];
};

export function emptyFlags(): IndexFlags {
  return { assumeUnchanged: [], skipWorktree: [] };
}

export function sameStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function sameFlags(actual: IndexFlags, expected: IndexFlags): boolean {
  return (
    sameStrings(actual.assumeUnchanged, expected.assumeUnchanged) &&
    sameStrings(actual.skipWorktree, expected.skipWorktree)
  );
}

export function sameTreeEntries(
  actual: readonly SnapshotTreeEntry[],
  expected: readonly SnapshotTreeEntry[],
): boolean {
  if (actual.length !== expected.length) return false;
  const expectedModes = new Map(
    expected.map(({ mode, path }) => [path, mode] as const),
  );
  if (expectedModes.size !== expected.length) return false;
  const actualPaths = new Set(actual.map(({ path }) => path));
  return (
    actualPaths.size === actual.length &&
    actual.every(({ mode, path }) => expectedModes.get(path) === mode)
  );
}

export function sameLiveEntries(
  actual: readonly SnapshotTreeEntry[],
  expected: readonly SnapshotTreeEntry[],
): boolean {
  if (!sameTreeEntries(actual, expected)) return false;
  const expectedPermissions = new Map(
    expected.map(({ path, permissions }) => [path, permissions] as const),
  );
  return actual.every(
    ({ path, permissions }) => expectedPermissions.get(path) === permissions,
  );
}

export function permissionOverrides(
  entries: readonly SnapshotTreeEntry[],
): Record<string, number> {
  return Object.fromEntries(
    entries.flatMap(({ mode, path, permissions }) => {
      if (permissions === undefined) return [];
      const ordinary = mode === "100755" ? 0o755 : 0o644;
      return permissions === ordinary ? [] : [[path, permissions] as const];
    }),
  );
}

export function metadataFor(snapshot: RecoverySnapshot): RecoveryMetadata {
  return {
    schema: "iva-update-recovery/v1",
    indexFlags: snapshot.indexFlags,
    worktreePermissions: permissionOverrides(snapshot.worktreeEntries),
    untrackedPermissions: permissionOverrides([
      ...snapshot.untrackedEntries,
      ...snapshot.ignoredCollisionEntries,
    ]),
    ignoredCollisionPaths: snapshot.ignoredCollisionEntries.map(
      ({ path }) => path,
    ),
    ignoredCollisionDirectories: Object.fromEntries(
      snapshot.ignoredCollisionDirectories.map(({ path, permissions }) => [
        path,
        permissions,
      ]),
    ),
    ignoredCollisionScopes: snapshot.ignoredCollisionScopes,
  };
}
