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
    return readFileSync(shimPath, "utf8").includes(`${install.home}/bin/iva.mjs`);
  } catch {
    return false;
  }
}

/** The git directory to ask about upstream: the mirror once one exists. */
export function gitRootFor(install: Install): string {
  const mirror = join(install.home, "repo");
  return existsSync(mirror) ? mirror : install.home;
}

/**
 * A shim that resolves paths and nothing else, so it never has to be rewritten
 * again: it prefers the active version and falls back to the tree it was
 * installed from, which is exactly the state a half-finished bridge leaves.
 */
export function shimScript(home: string, node: string): string {
  return [
    "#!/bin/sh",
    `IVA_ROOT="${home}"`,
    'if [ -f "$IVA_ROOT/current/bin/iva.mjs" ]; then',
    '  IVA_ROOT="$IVA_ROOT/current"',
    "fi",
    `exec "${node}" "$IVA_ROOT/bin/iva.mjs" "$@"`,
    "",
  ].join("\n");
}
