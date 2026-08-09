import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersionName } from "./version-store.ts";

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
 * What a symlink names, whether or not the target exists yet. One hop, not a full
 * resolve: this is for writing *through* a link, because replacing a version's
 * `.env` link with a file is how a version keeps state the next flip drops.
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
 * A tree somebody develops in, told apart from an installation by its git
 * history: install.sh clones one branch and never commits into it, so an
 * installation has a single local branch, no commits of its own, and is never a
 * linked worktree.
 */
function isDevelopmentCheckout(home: string): boolean {
  const dot = lstatSync(join(home, ".git"), { throwIfNoEntry: false });
  if (!dot) return false;
  if (!dot.isDirectory()) return true; // a linked worktree: nobody installs one
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", home, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const heads = git("for-each-ref", "--format=%(refname)", "refs/heads");
  if (heads === null) return false;
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
): boolean {
  if (install.kind === "version") return true;
  if (isDevelopmentCheckout(install.home)) return false;
  try {
    return shimPointsAt(readFileSync(shimPath, "utf8"), install.home);
  } catch {
    return false;
  }
}

/** Whether a shim script runs this installation, comparing paths resolved. */
export function shimPointsAt(shim: string, home: string): boolean {
  return [...shim.matchAll(/"([^"]+)"/gu)]
    .map((match) => real(match[1]))
    .some((path) => path === home || path.startsWith(`${home}/`));
}

/** The git directory to ask about upstream: the mirror once one exists. */
export function gitRootFor(install: Install): string {
  const mirror = join(install.home, "repo");
  return existsSync(mirror) ? mirror : install.home;
}

/**
 * True when `moduleUrl` names the module the process was started with. Both sides
 * are resolved: a string compare lies on macOS (`/tmp` is a link) and under the
 * versioned layout, where the launcher passes a path below `current`.
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const invoked = process.argv[1];
  return invoked ? real(invoked) === real(fileURLToPath(moduleUrl)) : false;
}

/**
 * A shim that resolves paths and nothing else, so it never has to be rewritten
 * again: the active version, else the tree it was installed from (what a
 * half-finished bridge leaves), else the version the installation settled on - a
 * lost `current` must take neither the repair command nor the release down with
 * it. install.sh writes this same script; the two stay in step.
 */
export function shimScript(home: string, node: string): string {
  return [
    "#!/bin/sh",
    `IVA_ROOT="${home}"`,
    'if [ -f "$IVA_ROOT/current/bin/iva.mjs" ]; then',
    '  IVA_ROOT="$IVA_ROOT/current"',
    'elif [ ! -f "$IVA_ROOT/bin/iva.mjs" ]; then',
    `  settled=$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$IVA_ROOT/data/active.json" 2>/dev/null)`,
    '  if [ -n "$settled" ] && [ -f "$IVA_ROOT/versions/$settled/bin/iva.mjs" ]; then',
    '    IVA_ROOT="$IVA_ROOT/versions/$settled"',
    "  else",
    '    for candidate in "$IVA_ROOT"/versions/*; do',
    '      [ -f "$candidate/bin/iva.mjs" ] && IVA_ROOT="$candidate"',
    "    done",
    "  fi",
    "fi",
    `exec "${node}" "$IVA_ROOT/bin/iva.mjs" "$@"`,
    "",
  ].join("\n");
}
