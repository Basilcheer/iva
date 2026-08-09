import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  isEntrypoint,
  SHIM_PATH,
  shimPointsAt,
  shimScript,
} from "./lib/version-layout.ts";
import {
  adoptUpdateLock,
  layoutFor,
  LEGACY_STATE_DIRS,
  STATE_DIRS,
} from "./lib/version-store.ts";
import {
  commandRunner,
  finishVersionUpdate,
  type UpdateOutcome,
} from "./lib/version-update.ts";

type Say = (message: string) => void;

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
  ...[...STATE_DIRS, ...LEGACY_STATE_DIRS].map(topLevel),
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

/** Install the shim that outlives every version; rewritten at most once. */
export function writeShim(home: string, log: Say): void {
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
 * runs instead. Only files git accounts for are removed, and only where the
 * checkout is clean: what the user added or edited stays where they left it,
 * because this is a layout change and not a right to delete their work.
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
        .map((entry) => topLevel(entry.slice(3).replace(/^"|"$/gu, ""))),
    );
  } catch {
    // Without git there is no telling the user's files from ours: keep everything.
    return [];
  }
  if (!tracked.includes("package.json")) return [];

  const removed: string[] = [];
  // Artifacts unconditionally: they are rebuilt, never authored, and the history
  // in .git is already mirrored into repo/.
  for (const name of [
    ...tracked.filter((name) => !dirty.has(name)),
    ...ARTIFACTS,
  ]) {
    if (KEEP.has(name)) continue;
    const path = join(home, name);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed.sort();
}

/**
 * Files the custom layer of the checkout era recorded as deleted. The overlay
 * that replaces it only ever adds files, so those deletions come undone with the
 * conversion, and a user who removed a stock skill has to be told it is back.
 */
export function tombstoned(home: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(home, "data/custom/manifest.json"), "utf8"),
    );
    const entries =
      (parsed as { entries?: Record<string, { tombstone?: boolean }> } | null)
        ?.entries ?? {};
    return Object.keys(entries)
      .filter((path) => entries[path]?.tombstone)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The second half of an update, run by the version being installed: install,
 * build, probe, flip, migrate, restart and retire the old checkout are the new
 * code's own logic, so a fix to any of it ships in the release carrying it.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [home, name, ...flags] = argv;
  if (!home || !name) throw new Error("usage: update-finish <home> <version>");
  const verbose = flags.includes("--verbose");
  const lock = adoptUpdateLock(layoutFor(home).data);
  const log: Say = (message) => console.log(`  ${message}`);
  const notify: Say = (message) => console.log(`! ${message}`);
  let outcome: UpdateOutcome;
  try {
    outcome = await finishVersionUpdate({
      home,
      name,
      run: commandRunner(verbose),
      log,
      notify,
      restart: async (root) => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        const { createCliSystemd } = await import("./cli/systemd.ts");
        // Units name `current`, never a version directory, so they survive every
        // later flip and garbage collection without being rewritten.
        const runtime = createCliRuntime(root);
        createCliSystemd(runtime).restartServices();
        runtime.systemd.activate([runtime.UPDATE_TIMER]);
        await Promise.resolve();
      },
      adopt: () => {
        writeShim(home, log);
        if (!existsSync(join(home, ".git"))) return;
        const back = tombstoned(home);
        if (back.length > 0)
          notify(
            `a version cannot have a file of Iva's own deleted from it, so ${back.length} you had removed are back: ${back.join(", ")}`,
          );
        for (const removed of retireCheckout(home)) log(`retired ${removed}`);
      },
    });
  } catch (error) {
    // The caller is another process: a stack trace on its terminal explains
    // nothing, and the update stays where the next run can pick it up.
    outcome = {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    lock.release();
  }
  const report = process.env.IVA_UPDATE_OUTCOME;
  if (report) writeFileSync(report, JSON.stringify(outcome));
  else console.log(JSON.stringify(outcome));
  return outcome.status === "updated" ? 0 : 1;
}

if (isEntrypoint(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
