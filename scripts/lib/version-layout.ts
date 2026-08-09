import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseVersionName } from "./version-store.ts";

/** The one command users have on their PATH; rewritten at most once, by the bridge. */
export const SHIM_PATH = join(homedir(), ".local/bin/iva");

export type Install = {
  /** `version` - already on the immutable layout; `checkout` - still a git working tree. */
  readonly kind: "version" | "checkout";
  readonly home: string;
  /**
   * How the running tree should be addressed by anything it writes down (systemd
   * units, the shim): `<home>/current` for a version, so those never name a
   * directory that the next update garbage-collects.
   */
  readonly root: string;
};

function real(path: string): string {
  try {
    return realpathSync(path);
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
 * Whether this tree is somebody's installation rather than a development
 * checkout. Only an installation may be converted to the immutable layout - a
 * checkout has to keep behaving like a checkout.
 */
export function isManagedInstall(
  install: Install,
  shimPath: string = SHIM_PATH,
): boolean {
  if (install.kind === "version") return true;
  try {
    return shimPointsAt(readFileSync(shimPath, "utf8"), install.home);
  } catch {
    return false;
  }
}

/**
 * Whether a shim script runs this installation. The paths it spells out are
 * compared resolved: the path an `iva` was installed with can reach the same
 * tree through a symlink.
 */
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
 * A shim that resolves paths and nothing else, so it never has to be rewritten
 * again: the active version, else the tree it was installed from (the state a
 * half-finished bridge leaves), else the newest version there is - because a
 * lost `current` must not take the command that repairs it down with it.
 */
export function shimScript(home: string, node: string): string {
  return [
    "#!/bin/sh",
    `IVA_ROOT="${home}"`,
    'if [ -f "$IVA_ROOT/current/bin/iva.mjs" ]; then',
    '  IVA_ROOT="$IVA_ROOT/current"',
    'elif [ ! -f "$IVA_ROOT/bin/iva.mjs" ]; then',
    '  for candidate in "$IVA_ROOT"/versions/*; do',
    '    [ -f "$candidate/bin/iva.mjs" ] && IVA_ROOT="$candidate"',
    "  done",
    "fi",
    `exec "${node}" "$IVA_ROOT/bin/iva.mjs" "$@"`,
    "",
  ].join("\n");
}
