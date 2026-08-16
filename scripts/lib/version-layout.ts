import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVersionStore, parseVersionName } from "./version-store.ts";

/** The one command users have on their PATH; rewritten at most once, by the bridge. */
export const SHIM_PATH = join(homedir(), ".local/bin/iva");

export type Install = {
  /** `version` - already on the immutable layout; `checkout` - still a git working tree. */
  readonly kind: "version" | "checkout";
  readonly home: string;
  /** How units and the shim must address the tree: never a collectable directory. */
  readonly root: string;
};

/** Where a path really leads, or the path itself when nothing is there yet. */
export function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * What a symlink names, target or no target. One hop, not a full resolve: writing
 * *through* the link is what keeps a version from turning shared state into its own.
 */
export function throughLink(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink()
      ? resolve(dirname(path), readlinkSync(path))
      : path;
  } catch {
    return path;
  }
}

/** Where a version directory is reachable from without naming the version. */
export function stableRoot(dir: string): string {
  const current = join(dirname(dirname(dir)), "current");
  return real(current) === real(dir) ? current : dir;
}

/** Tell an installed version apart from a plain checkout by its position on disk. */
export function classifyRoot(root: string): Install {
  const dir = real(root);
  const parent = dirname(dir);
  if (basename(parent) === "versions" && parseVersionName(basename(dir)))
    return { kind: "version", home: dirname(parent), root: stableRoot(dir) };
  return { kind: "checkout", home: dir, root: dir };
}

/**
 * A tree somebody develops in, told from an installation by its git history:
 * install.sh clones one branch and never commits into it, so an installation has
 * one local branch, nothing of its own on top, and is never a linked worktree.
 */
function isDevelopmentCheckout(home: string): boolean {
  const dot = lstatSync(join(home, ".git"), { throwIfNoEntry: false });
  if (!dot) return false;
  if (!dot.isDirectory()) return true; // a linked worktree: nobody installs one
  const git = (...args: string[]): string => {
    try {
      return execFileSync("git", ["-C", home, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return ""; // Not a repository this process can read: not one to protect.
    }
  };
  const heads = git("for-each-ref", "--format=%(refname)", "refs/heads");
  return (
    heads.split("\n").filter(Boolean).length > 1 ||
    Number(git("rev-list", "--count", "@{upstream}..HEAD")) > 0
  );
}

/**
 * Only somebody's installation may be converted to the immutable layout. The
 * conversion retires the working tree it finds, so a checkout somebody develops
 * in is left on the in-place updater even when their shim points at it.
 */
export function isManagedInstall(
  install: Install,
  shimPath: string = SHIM_PATH,
  node: string = process.execPath,
): boolean {
  if (install.kind === "version") return true;
  if (isDevelopmentCheckout(install.home)) return false;
  const opened = openShim(shimPath);
  if (opened.kind !== "file") return false;
  try {
    return isOwnedShim(opened.text, install.home, node);
  } finally {
    closeShim(opened.fd);
  }
}

/** Whether a shim script runs this installation, comparing paths resolved. */
export function shimPointsAt(shim: string, home: string): boolean {
  return [...shim.matchAll(/"([^"]+)"/gu)]
    .map((match) => real(match[1]))
    .some((path) => path === home || path.startsWith(`${home}/`));
}

/** Exact generated-shim grammar used only before replacing an existing command. */
function isOwnedShim(
  shim: string,
  home: string,
  expectedNode: string,
): boolean {
  const lines = shim.split("\n");
  const exec = (line: string | undefined): string | null =>
    /^exec "([^"\\$`\r\n]+)" "\$IVA_ROOT\/bin\/iva\.mjs" "\$@"$/u.exec(
      line ?? "",
    )?.[1] ?? null;
  const data = (line: string | undefined): string | null => {
    const match = /^IVA_DATA="((?:[^"\\$`\r\n]|\\[\\"$`])*)"$/u.exec(
      line ?? "",
    );
    return match ? match[1].replace(/\\([\\"$`])/gu, "$1") : null;
  };

  // Older installations ran their checkout directly before the version bridge.
  const direct = /^exec "([^"\\$`\r\n]+)" "([^"\\$`\r\n]+)" "\$@"$/u.exec(
    lines[1] ?? "",
  );
  if (lines.length === 3 && lines[0] === "#!/usr/bin/env bash" && direct) {
    const node = direct[1];
    const target = direct[2];
    return (
      basename(node) === "node" &&
      real(node) === real(expectedNode) &&
      basename(target) === "iva.mjs" &&
      basename(dirname(target)) === "bin" &&
      real(dirname(dirname(target))) === real(home) &&
      lines[2] === ""
    );
  }

  const root = /^IVA_ROOT="([^"\\$`\r\n]+)"$/u.exec(lines[1] ?? "");
  if (!root || real(root[1]) !== real(home)) return false;
  const writtenHome = root[1];

  if (lines.length === 19) {
    const writtenData = data(lines[2]);
    const node = exec(lines[17]);
    return (
      writtenData !== null &&
      node !== null &&
      real(node) === real(expectedNode) &&
      shim === shimScript(writtenHome, node, writtenData)
    );
  }

  // The previous release had no IVA_DATA snapshot and always read home/data.
  const node = exec(lines[16]);
  if (lines.length !== 18 || node === null || real(node) !== real(expectedNode))
    return false;
  const expected = shimScript(
    writtenHome,
    node,
    join(writtenHome, "data"),
  ).split("\n");
  expected.splice(2, 1);
  expected[5] = expected[5].replace(
    "$IVA_DATA/active.json",
    "$IVA_ROOT/data/active.json",
  );
  return shim === expected.join("\n");
}

type OpenShim =
  | { readonly kind: "missing" | "foreign" }
  | {
      readonly kind: "file";
      readonly fd: number;
      readonly text: string;
      readonly dev: bigint;
      readonly ino: bigint;
    };

function closeShim(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The read proof or fully fsynced publication already defines the outcome.
  }
}

/** Open one exact regular-file entry, never a symlink target. */
function openShim(path: string): OpenShim {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "foreign" };
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) {
      closeShim(fd);
      return { kind: "foreign" };
    }
    return {
      kind: "file",
      fd,
      text: readFileSync(fd, "utf8"),
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch {
    closeShim(fd);
    return { kind: "foreign" };
  }
}

function sameOpenShim(
  path: string,
  opened: Extract<OpenShim, { kind: "file" }>,
): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return (
      stat.isFile() &&
      stat.nlink === 1n &&
      stat.dev === opened.dev &&
      stat.ino === opened.ino
    );
  } catch {
    return false;
  }
}

type ClaimedShim = { readonly directory: string; readonly path: string };

function restoreClaim(claim: ClaimedShim, shimPath: string): boolean {
  try {
    linkSync(claim.path, shimPath);
    unlinkSync(claim.path);
    rmdirSync(claim.directory);
    return true;
  } catch {
    return false;
  }
}

/** Move the exact inspected entry aside before publishing a replacement. */
function claimOpenShim(
  shimPath: string,
  opened: Extract<OpenShim, { kind: "file" }>,
): ClaimedShim | null {
  const directory = mkdtempSync(join(dirname(shimPath), ".iva-shim-refresh-"));
  const claim = { directory, path: join(directory, "previous") };
  try {
    renameSync(shimPath, claim.path);
  } catch (cause) {
    rmdirSync(directory);
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  if (sameOpenShim(claim.path, opened)) return claim;
  if (!restoreClaim(claim, shimPath))
    throw new Error(
      `shim ownership changed; foreign entry kept at ${claim.path}`,
    );
  return null;
}

function removeClaim(claim: ClaimedShim): void {
  unlinkSync(claim.path);
  rmdirSync(claim.directory);
}

function preserveClaim(claim: ClaimedShim, shimPath: string): string {
  const recovery = `${shimPath}.iva-recovery-${randomUUID()}`;
  try {
    renameSync(claim.directory, recovery);
    return recovery;
  } catch (cause) {
    throw new Error(
      `failed to preserve displaced shim from ${claim.path} at ${recovery}`,
      { cause },
    );
  }
}

/**
 * The git directory to ask about upstream: the mirror once one exists, and on the
 * immutable layout nothing else - git discovery climbs parents, so falling back to
 * a home without a repository answers about whatever repo `$HOME` happens to be in.
 */
export function gitRootFor(install: Install): string {
  const mirror = join(install.home, "repo");
  return install.kind === "version" || existsSync(mirror)
    ? mirror
    : install.home;
}

/**
 * What to ask about upstream from a tree the code is running out of, on either
 * layout: which repository answers, and which commit counts as installed. On the
 * immutable layout the mirror's own HEAD moves with the remote, so the running
 * version has to name its commit or the check compares upstream against itself.
 */
export function upstreamQuery(root: string): { root: string; head: string } {
  const install = classifyRoot(root);
  const active = createVersionStore(install.home).currentName();
  return {
    root: gitRootFor(install),
    head: (active && parseVersionName(active)?.sha) || "HEAD",
  };
}

/**
 * Whether `moduleUrl` is the module the process was started with. Both sides are
 * resolved: a string compare lies on macOS and below `current`.
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const invoked = process.argv[1];
  return invoked ? real(invoked) === real(fileURLToPath(moduleUrl)) : false;
}

/**
 * A shim that resolves paths and nothing else, so only its owned path snapshot changes: the
 * active version, else the tree it was installed from (what a half-finished bridge
 * leaves), else the one settled on last, else the newest built - a lost `current`
 * must take neither the repair command nor the release with it, and a name sorts
 * by string, not by release. install.sh writes the same script.
 */
function shellDoubleQuoted(value: string): string {
  if (/[\0\r\n]/u.test(value))
    throw new Error("shell path contains NUL or a newline");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

export function shimScript(
  home: string,
  node: string,
  dataDir: string,
): string {
  return [
    "#!/bin/sh",
    `IVA_ROOT="${home}"`,
    `IVA_DATA=${shellDoubleQuoted(dataDir)}`,
    'if [ -f "$IVA_ROOT/current/bin/iva.mjs" ]; then',
    '  IVA_ROOT="$IVA_ROOT/current"',
    'elif [ ! -f "$IVA_ROOT/bin/iva.mjs" ]; then',
    `  settled=$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$IVA_DATA/active.json" 2>/dev/null)`,
    '  if [ -n "$settled" ] && [ -f "$IVA_ROOT/versions/$settled/bin/iva.mjs" ]; then',
    '    IVA_ROOT="$IVA_ROOT/versions/$settled"',
    "  else",
    '    for candidate in $(ls -t "$IVA_ROOT/versions" 2>/dev/null); do',
    '      [ -f "$IVA_ROOT/versions/$candidate/bin/iva.mjs" ] || continue',
    '      IVA_ROOT="$IVA_ROOT/versions/$candidate"',
    "      break",
    "    done",
    "  fi",
    "fi",
    `exec "${node}" "$IVA_ROOT/bin/iva.mjs" "$@"`,
    "",
  ].join("\n");
}

/** Refresh an Iva-owned shim without replacing another program at the same path. */
export function refreshOwnedShim(
  shimPath: string,
  home: string,
  node: string,
  dataDir: string,
): boolean {
  const desired = shimScript(home, node, dataDir);
  const opened = openShim(shimPath);
  if (opened.kind === "foreign") return false;
  if (opened.kind === "file") {
    const claim = (() => {
      try {
        if (opened.text === desired) return null;
        if (!isOwnedShim(opened.text, home, node)) return null;
        if (!sameOpenShim(shimPath, opened)) return null;
        return claimOpenShim(shimPath, opened);
      } finally {
        closeShim(opened.fd);
      }
    })();
    if (!claim) return false;
    try {
      const published = createShimExclusive(shimPath, desired);
      if (published) removeClaim(claim);
      else preserveClaim(claim, shimPath);
      return published;
    } catch (cause) {
      if (!restoreClaim(claim, shimPath))
        throw new Error(`failed to restore owned shim from ${claim.path}`, {
          cause,
        });
      throw cause;
    }
  }

  mkdirSync(dirname(shimPath), { recursive: true });
  return createShimExclusive(shimPath, desired);
}

function createShimExclusive(shimPath: string, desired: string): boolean {
  let fd: number;
  try {
    fd = openSync(
      shimPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o755,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw cause;
  }
  let created: Extract<OpenShim, { kind: "file" }> | null = null;
  try {
    const stat = fstatSync(fd, { bigint: true });
    created = {
      kind: "file" as const,
      fd,
      text: "",
      dev: stat.dev,
      ino: stat.ino,
    };
    writeAllSync(fd, desired);
    fchmodSync(fd, 0o755);
    fsyncSync(fd);
    return sameOpenShim(shimPath, created);
  } catch (cause) {
    if (created && sameOpenShim(shimPath, created)) unlinkSync(shimPath);
    throw cause;
  } finally {
    closeShim(fd);
  }
}

function writeAllSync(fd: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error("shim write made no progress");
    offset += written;
  }
}
