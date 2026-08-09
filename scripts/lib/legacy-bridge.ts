import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SHIM_PATH, shimPointsAt, shimScript } from "./version-layout.ts";
import { STATE_DIRS } from "./version-store.ts";

/** Build leftovers of a checkout: not tracked, not state, never worth keeping. */
const ARTIFACTS = [
  ".git",
  ".iva-build",
  ".iva-update",
  ".output",
  ".worktrees",
  "node_modules",
];
/** First path segment, for both `agent/tools/x.ts` and a bare `install.sh`. */
function topLevel(path: string): string {
  return path.split("/", 1)[0] ?? "";
}

/** Never removed, whatever git says about them. */
const KEEP = new Set([
  ...STATE_DIRS.map(topLevel),
  ".env",
  "current",
  "repo",
  "versions",
]);

function git(home: string, args: string[]): string {
  return execFileSync("git", ["-C", home, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
}

/**
 * Install the shim that outlives every version. It is rewritten at most once -
 * from then on it already prefers `current` and only resolves paths.
 */
export function writeShim(home: string, log: (message: string) => void): void {
  let existing = "";
  try {
    existing = readFileSync(SHIM_PATH, "utf8");
  } catch {
    // A missing shim is written below; the command has to exist either way.
  }
  if (existing.includes("$IVA_ROOT/current/bin/iva.mjs")) return;
  if (existing && !shimPointsAt(existing, home)) return; // someone else's `iva`
  mkdirSync(dirname(SHIM_PATH), { recursive: true });
  writeFileSync(SHIM_PATH, shimScript(home, process.execPath));
  chmodSync(SHIM_PATH, 0o755);
  log(`rewrote ${SHIM_PATH}`);
}

/**
 * Remove the working tree the installation used to run from, now that a version
 * directory runs instead.
 *
 * Only files git accounts for are removed, and only where the checkout is clean:
 * anything the user added or edited stays exactly where they left it, because
 * this is a layout change and not a right to delete their work.
 */
export function retireCheckout(home: string): string[] {
  let tracked: string[];
  let dirty: Set<string>;
  try {
    tracked = git(home, ["ls-tree", "--name-only", "HEAD"])
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
    dirty = new Set(
      git(home, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])
        .split("\0")
        .filter(Boolean)
        .map((entry) => topLevel(entry.slice(3).replace(/^"|"$/g, ""))),
    );
  } catch {
    // Without git there is no way to tell the user's files from ours: keep everything.
    return [];
  }
  if (!tracked.includes("package.json")) return [];

  const removed: string[] = [];
  // Artifacts unconditionally: they are rebuilt, never authored, and the history
  // in .git is already mirrored into repo/.
  for (const name of [...tracked.filter((name) => !dirty.has(name)), ...ARTIFACTS]) {
    if (KEEP.has(name)) continue;
    const path = join(home, name);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed.sort();
}
