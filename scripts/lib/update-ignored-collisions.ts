import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, sep } from "node:path";

type GitResult = { code: number; stdout: string; stderr: string };

type CollisionGit = {
  run(
    args: string[],
    options?: {
      input?: Buffer;
      rawOutput?: boolean;
    },
  ): Promise<GitResult>;
};

export type IgnoredCollisionEntry = {
  mode: string;
  path: string;
  permissions?: number;
  device: number;
  inode: number;
};

export type IgnoredCollisionDirectory = {
  path: string;
  permissions: number;
  device: number;
  inode: number;
};

export type IgnoredCollisionPlan = {
  entries: IgnoredCollisionEntry[];
  directories: IgnoredCollisionDirectory[];
  scopes: string[];
};

export type IgnoredCollisionIdentity = readonly [device: number, inode: number];

export type IgnoredCollisionContentEntry = IgnoredCollisionEntry & {
  bytes: Buffer;
};

export function verifyIgnoredCollisionOwnership({
  root,
  entries,
  directories,
  identities,
}: {
  root: string;
  entries: readonly IgnoredCollisionContentEntry[];
  directories: readonly IgnoredCollisionDirectory[];
  identities?: ReadonlyMap<string, IgnoredCollisionIdentity>;
}): Map<string, IgnoredCollisionIdentity> {
  const current = new Map<string, IgnoredCollisionIdentity>();
  const changed = (path: string): never => {
    throw new Error(`ignored recovery collision ownership changed: ${path}`);
  };
  for (const entry of entries) {
    const stat = lstat(root, entry.path);
    if (!stat) return changed(entry.path);
    const target = safeChild(root, entry.path);
    const bytes =
      entry.mode === "120000"
        ? stat.isSymbolicLink()
          ? readlinkSync(target, { encoding: "buffer" })
          : changed(entry.path)
        : stat.isFile()
          ? readFileSync(target)
          : changed(entry.path);
    if (
      !bytes.equals(entry.bytes) ||
      (entry.permissions !== undefined &&
        (stat.mode & 0o777) !== entry.permissions)
    )
      changed(entry.path);
    current.set(entry.path, [stat.dev, stat.ino]);
  }
  for (const entry of directories) {
    const stat = lstat(root, entry.path);
    if (
      !stat ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== entry.permissions
    )
      return changed(entry.path);
    current.set(entry.path, [stat.dev, stat.ino]);
  }
  if (identities) {
    for (const [path, identity] of current) {
      const expected = identities.get(path);
      if (
        !expected ||
        expected[0] !== identity[0] ||
        expected[1] !== identity[1]
      )
        changed(path);
    }
  }
  return current;
}

export async function verifyIgnoredCollisionSet({
  git,
  scopes,
  entries,
}: {
  git: CollisionGit;
  scopes: readonly string[];
  entries: readonly IgnoredCollisionEntry[];
}): Promise<void> {
  if (scopes.length === 0) return;
  const result = await git.run(
    [
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ...scopes,
    ],
    { rawOutput: true },
  );
  if (result.code !== 0)
    throw new Error(
      result.stderr || result.stdout || "couldn't verify ignored collisions",
    );
  const actual = result.stdout.split("\0").filter(Boolean).sort(comparePaths);
  const expected = entries.map(({ path }) => path).sort(comparePaths);
  if (
    actual.length !== expected.length ||
    actual.some((path, index) => path !== expected[index])
  )
    throw new Error("ignored recovery collision path set changed");
}

export function removeIgnoredCollisionPaths({
  root,
  entries,
  directories,
  scopes,
  remove = (path) => unlinkSync(path),
  removeDirectory = (path) => rmdirSync(path),
}: {
  root: string;
  entries: readonly IgnoredCollisionEntry[];
  directories: readonly IgnoredCollisionDirectory[];
  scopes: readonly string[];
  remove?: (path: string) => void;
  removeDirectory?: (path: string) => void;
}): void {
  const deepestFirst = (left: string, right: string) =>
    right.split("/").length - left.split("/").length ||
    comparePaths(left, right);
  const leaves = entries.map(({ path }) => path).sort(deepestFirst);
  for (const relative of leaves) remove(safeChild(root, relative));
  const removableDirectories = [
    ...new Set([...directories.map(({ path }) => path), ...scopes]),
  ].sort(deepestFirst);
  for (const relative of removableDirectories) {
    try {
      removeDirectory(safeChild(root, relative));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST")
        continue;
      throw error;
    }
  }
  for (const relative of leaves) {
    if (lstat(root, relative))
      throw new Error(
        `ignored recovery collision was not removed: ${relative}`,
      );
  }
  for (const relative of scopes) {
    if (lstat(root, relative))
      throw new Error(
        `ignored recovery collision was not removed: ${relative}`,
      );
  }
}

export function restoreIgnoredCollisionDirectories(
  root: string,
  entries: readonly IgnoredCollisionDirectory[],
): void {
  const shallowFirst = [...entries].sort(
    (left, right) => left.path.split("/").length - right.path.split("/").length,
  );
  for (const { path } of shallowFirst)
    mkdirSync(safeChild(root, path), { recursive: true });
  for (const { path, permissions } of shallowFirst.reverse())
    chmodSync(safeChild(root, path), permissions);
}

export function verifyIgnoredCollisionDirectories(
  root: string,
  entries: readonly IgnoredCollisionDirectory[],
): void {
  for (const { path, permissions } of entries) {
    const stat = lstatSync(safeChild(root, path));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        `git recovery snapshot directory does not match: ${path}`,
      );
    if ((stat.mode & 0o777) !== permissions)
      throw new Error(
        `git recovery snapshot directory permissions do not match: ${path}`,
      );
  }
}

type FilesystemEntry =
  | {
      kind: "directory";
      path: string;
      permissions: number;
      device: number;
      inode: number;
    }
  | { kind: "leaf"; path: string };

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeChild(root: string, relative: string): string {
  const base = resolve(root);
  const target = resolve(root, relative);
  if (target === base || !target.startsWith(`${base}${sep}`))
    throw new Error("unsafe path in ignored update collision");
  return target;
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

function lstat(root: string, path: string) {
  try {
    return lstatSync(safeChild(root, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function collisionCandidate(
  root: string,
  targetPath: string,
): FilesystemEntry | null {
  const parts = targetPath.split("/");
  for (let length = 1; length <= parts.length; length += 1) {
    const path = parts.slice(0, length).join("/");
    const stat = lstat(root, path);
    if (!stat) return null;
    const exact = length === parts.length;
    if (!exact && stat.isDirectory() && !stat.isSymbolicLink()) continue;
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? {
          kind: "directory",
          path,
          permissions: stat.mode & 0o777,
          device: stat.dev,
          inode: stat.ino,
        }
      : { kind: "leaf", path };
  }
  return null;
}

function walkDirectory(
  root: string,
  directory: string,
  entries: Map<string, FilesystemEntry>,
): void {
  const stat = lstat(root, directory);
  if (!stat) throw new Error(`ignored collision disappeared: ${directory}`);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    entries.set(directory, { kind: "leaf", path: directory });
    return;
  }
  entries.set(directory, {
    kind: "directory",
    path: directory,
    permissions: stat.mode & 0o777,
    device: stat.dev,
    inode: stat.ino,
  });
  const children = readdirSync(safeChild(root, directory), {
    withFileTypes: true,
  })
    .map(({ name }) => name)
    .sort(comparePaths);
  for (const name of children)
    walkDirectory(root, `${directory}/${name}`, entries);
}

async function ignoredPaths(
  git: CollisionGit,
  paths: readonly string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const result = await git.run(
    ["check-ignore", "--no-index", "--stdin", "-z"],
    {
      input: Buffer.from(`${paths.map((path) => `./${path}`).join("\0")}\0`),
      rawOutput: true,
    },
  );
  if (result.code === 1 && !result.stderr) return new Set();
  if (result.code !== 0)
    throw new Error(
      result.stderr || result.stdout || "couldn't inspect ignored collisions",
    );
  return new Set(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map((path) => (path.startsWith("./") ? path.slice(2) : path)),
  );
}

export async function planIgnoredCollisions({
  root,
  targetOid,
  indexPaths,
  untrackedPaths,
  excludedRoots,
  git,
}: {
  root: string;
  targetOid: string;
  indexPaths: readonly string[];
  untrackedPaths: readonly string[];
  excludedRoots: readonly string[];
  git: CollisionGit;
}): Promise<IgnoredCollisionPlan> {
  const target = await git.run(
    ["ls-tree", "-r", "-z", "--name-only", targetOid],
    { rawOutput: true },
  );
  if (target.code !== 0)
    throw new Error(
      target.stderr || target.stdout || "couldn't inspect update target paths",
    );
  const indexed = new Set(indexPaths);
  const ordinaryUntracked = new Set(untrackedPaths);
  const candidates = new Map<string, FilesystemEntry>();
  const candidateScopes = new Set<string>();
  const targetPaths = target.stdout.split("\0").filter(Boolean);

  for (const targetPath of targetPaths) {
    safeChild(root, targetPath);
    if (indexed.has(targetPath)) continue;
    const managed = excludedRoots.find((path) =>
      pathsOverlap(targetPath, path),
    );
    if (managed)
      throw new Error(`update target collides with managed path: ${managed}`);
    const candidate = collisionCandidate(root, targetPath);
    if (!candidate) continue;
    if (candidate.kind === "leaf" && indexed.has(candidate.path)) continue;
    if (candidate.kind === "leaf" && ordinaryUntracked.has(candidate.path))
      continue;
    candidateScopes.add(candidate.path);
    if (candidate.kind === "directory")
      walkDirectory(root, candidate.path, candidates);
    else candidates.set(candidate.path, candidate);
  }

  const candidatePaths = [...candidates.keys()].sort(comparePaths);
  const ignored = await ignoredPaths(git, candidatePaths);
  const selectedLeaves = [...candidates.values()]
    .filter(
      (entry): entry is Extract<FilesystemEntry, { kind: "leaf" }> =>
        entry.kind === "leaf" &&
        ignored.has(entry.path) &&
        !indexed.has(entry.path) &&
        !ordinaryUntracked.has(entry.path),
    )
    .sort((left, right) => comparePaths(left.path, right.path));
  const selectedDirectories = [...candidates.values()]
    .filter(
      (entry): entry is Extract<FilesystemEntry, { kind: "directory" }> =>
        entry.kind === "directory" &&
        (ignored.has(entry.path) ||
          selectedLeaves.some(({ path }) => isInside(path, entry.path))),
    )
    .map(({ path, permissions, device, inode }) => ({
      path,
      permissions,
      device,
      inode,
    }))
    .sort((left, right) => comparePaths(left.path, right.path));
  const selectedPaths = [
    ...selectedLeaves.map(({ path }) => path),
    ...selectedDirectories.map(({ path }) => path),
  ];
  const scopes = [...candidateScopes]
    .filter((scope) => selectedPaths.some((path) => isInside(path, scope)))
    .sort(comparePaths);

  const entries = selectedLeaves.map(({ path }) => {
    const stat = lstat(root, path);
    if (!stat) throw new Error(`ignored collision disappeared: ${path}`);
    if (stat.isSymbolicLink())
      return {
        mode: "120000",
        path,
        device: stat.dev,
        inode: stat.ino,
      };
    if (stat.isFile())
      return {
        mode: stat.mode & 0o111 ? "100755" : "100644",
        path,
        permissions: stat.mode & 0o777,
        device: stat.dev,
        inode: stat.ino,
      };
    throw new Error(`unsupported ignored collision: ${path}`);
  });
  return { entries, directories: selectedDirectories, scopes };
}
