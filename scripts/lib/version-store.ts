import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const INCOMPLETE = ".iva-incomplete";
const SETTLED = "active.json";
const LOCK = "update.lock";
const STALE_MS = 60 * 60 * 1000;
const FLIP_PREFIX = ".current.iva-flip-";
/** Names in `home` that only an interrupted update can leave behind. */
const LEFTOVER = [FLIP_PREFIX, ".probe-"];
const VERSION_NAME =
  /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-([0-9a-f]{12})(?:\+([0-9a-f]{8}))?(?:~(\d+))?$/;
/** What a version borrows from the installation; the rest of `.eve` is a build cache. */
export const STATE_DIRS = ["data", "vault", ".eve/.workflow-data"];
/** Where older builds kept the workflow store: linked where one is, never created. */
export const LEGACY_STATE_DIRS = [".workflow-data"];

/** Where an installation keeps things; state and the mirror outlive every version. */
export function layoutFor(home: string) {
  return {
    home,
    repo: join(home, "repo"),
    versions: join(home, "versions"),
    current: join(home, "current"),
    data: join(home, "data"),
    vault: join(home, "vault"),
    env: join(home, ".env"),
  };
}

/** Release, commit and a digest of the user's files; `build` numbers rebuilds of one. */
export function versionName(
  version: string,
  sha: string,
  overlay: string | null = null,
  build = 1,
): string {
  const tail = `${overlay ? `+${overlay}` : ""}${build > 1 ? `~${build}` : ""}`;
  return `${version}-${sha.slice(0, 12)}${tail}`;
}

export function parseVersionName(name: string) {
  const match = VERSION_NAME.exec(name);
  if (!match) return null;
  return {
    version: match[1],
    sha: match[2],
    overlay: match[3] ?? null,
    build: match[4] ? Number(match[4]) : 1,
  };
}

/** The release a directory is a build of; two builds of one release run the same code. */
export function releaseOf(name: string): string {
  const at = parseVersionName(name);
  return at ? versionName(at.version, at.sha, at.overlay) : name;
}

/** Through a file, not a pipe: two joined processes are a second failure mode. */
function unpack(command: string, args: string[], cwd: string): void {
  const done = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (!done.error && done.status === 0) return;
  const why = done.error?.message ?? (done.stderr || "").trim();
  throw new Error(`materialize failed: ${why || command}`);
}

/**
 * Immutable version directories plus one symlink saying which runs. Every mutation
 * is confined to a directory nothing points at, or is one atomic rename, so an
 * interruption leaves garbage and never half a changed installation.
 */
export function createVersionStore(home: string) {
  const layout = layoutFor(home);

  const versionDir = (name: string): string => {
    if (!parseVersionName(name)) throw new Error(`invalid version: ${name}`);
    return join(layout.versions, name);
  };

  /** A directory without the marker is a version; with it, it is garbage. */
  const isComplete = (name: string): boolean =>
    existsSync(join(layout.versions, name)) &&
    !existsSync(join(layout.versions, name, INCOMPLETE));

  const names = (): string[] => {
    try {
      return readdirSync(layout.versions).sort();
    } catch {
      return [];
    }
  };

  /** Finished versions, newest first. */
  function list(): string[] {
    return names()
      .filter((name) => parseVersionName(name) && isComplete(name))
      .map((name) => ({
        name,
        at: statSync(join(layout.versions, name)).mtimeMs,
      }))
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
      .map((entry) => entry.name);
  }

  /** The active version; null when the link is missing, dangling or foreign. */
  function currentName(): string | null {
    let target: string;
    let versions: string;
    try {
      if (!lstatSync(layout.current).isSymbolicLink()) return null;
      target = realpathSync(layout.current);
      versions = realpathSync(layout.versions);
    } catch {
      return null;
    }
    if (dirname(target) !== versions) return null;
    const name = target.slice(versions.length + 1);
    return parseVersionName(name) && isComplete(name) ? name : null;
  }

  function previousName(): string | null {
    const active = currentName();
    return list().find((name) => name !== active) ?? null;
  }

  /** A free directory for the next build of a release, beside the running one. */
  function nextBuild(release: string): string {
    const at = parseVersionName(release);
    if (!at) throw new Error(`invalid version: ${release}`);
    for (let build = 1; build <= 99; build++) {
      const name = versionName(at.version, at.sha, at.overlay, build);
      if (!existsSync(join(layout.versions, name))) return name;
    }
    throw new Error(`too many builds of ${release} on disk`);
  }

  /** Claim a version directory. Fails loudly rather than touching anything live. */
  function stage(name: string): string {
    const dir = versionDir(name);
    if (name === currentName())
      throw new Error(`version ${name} is already active`);
    mkdirSync(layout.versions, { recursive: true });
    try {
      mkdirSync(dir);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`version ${name} already exists`, { cause: caught });
      throw caught;
    }
    mkdirSync(join(dir, INCOMPLETE));
    return dir;
  }

  function complete(name: string): void {
    rmSync(join(versionDir(name), INCOMPLETE), {
      recursive: true,
      force: true,
    });
  }

  /** Empty a staged version so it can be rebuilt without losing the claim on it. */
  function reset(name: string): string {
    const dir = versionDir(name);
    if (isComplete(name)) throw new Error(`version ${name} is complete`);
    for (const entry of readdirSync(dir))
      if (entry !== INCOMPLETE)
        rmSync(join(dir, entry), { recursive: true, force: true });
    return dir;
  }

  /** Point `current` at a finished version with one rename. */
  function activate(name: string): void {
    const dir = versionDir(name);
    if (!isComplete(name)) throw new Error(`version ${name} is incomplete`);
    linkState(dir); // Whatever a killed probe aimed them at, back at the install.

    const flip = join(home, `${FLIP_PREFIX}${process.pid}-${Date.now()}`);
    rmSync(flip, { recursive: true, force: true });
    symlinkSync(dir, flip);
    try {
      // rename() replaces a symlink atomically; anything else there is not ours to keep.
      const link = layout.current;
      if (existsSync(link) && !lstatSync(link).isSymbolicLink())
        rmSync(link, { recursive: true, force: true });
      renameSync(flip, link);
    } catch (error) {
      rmSync(flip, { recursive: true, force: true });
      throw error;
    }
  }

  /** Flipped, migrated, restarted: an update is owed while this and `current` disagree. */
  function settled(): string | null {
    const name = readJson(join(layout.data, SETTLED)).version;
    return typeof name === "string" ? name : null;
  }

  /** Written last in an update, so an interrupted one is replayed rather than lost. */
  function settle(name: string): void {
    mkdirSync(layout.data, { recursive: true });
    writeJson(join(layout.data, SETTLED), {
      schema: "iva-active/v1",
      version: name,
    });
  }

  /** Remove what an interrupted update can leave behind. Never touches a version. */
  function sweep(): string[] {
    const stale = names().filter(
      (name) => parseVersionName(name) && !isComplete(name),
    );
    for (const name of stale)
      rmSync(join(layout.versions, name), { recursive: true, force: true });
    for (const name of readdirSync(home).sort()) {
      if (!LEFTOVER.some((prefix) => name.startsWith(prefix))) continue;
      rmSync(join(home, name), { recursive: true, force: true });
      stale.push(name);
    }
    return stale;
  }

  /** Keep the active version plus the newest others; disks on these boxes are small. */
  function gc(keep: number): string[] {
    const active = currentName();
    const kept = new Set(active ? [active] : []);
    const finished = list();
    for (const name of finished) {
      if (kept.size >= Math.max(keep, 1)) break;
      kept.add(name);
    }
    const removed = finished.filter((name) => !kept.has(name));
    for (const name of removed)
      rmSync(join(layout.versions, name), { recursive: true, force: true });
    return removed.sort();
  }

  /** Make `current` valid again after a manual edit or a crash. */
  function heal(): string | null {
    const active = currentName();
    if (active) return active;
    // Not the newest on disk: after a rollback that one is the rejected version.
    const chosen = settled();
    const pick = list().find((name) => name === chosen) ?? list()[0];
    if (!pick) return null;
    activate(pick);
    return pick;
  }

  /** Fill a staged directory with the exact tree of one commit, without git state. */
  async function materialize(at: { sha: string; dir: string }): Promise<void> {
    await Promise.resolve();
    const archive = join(at.dir, ".iva-archive.tar");
    const args = ["archive", "--format=tar", `--output=${archive}`, at.sha];
    try {
      unpack("git", args, layout.repo);
      unpack("tar", ["-x", "-f", archive], at.dir);
    } finally {
      rmSync(archive, { force: true });
    }
  }

  /** State outlives versions: `stateHome` is the installation, or scratch for a probe. */
  function linkState(dir: string, stateHome: string = home): void {
    const links = STATE_DIRS.map((name): [string, string] => [
      name,
      join(stateHome, name),
    ]);
    for (const name of LEGACY_STATE_DIRS) {
      // Cleared even where nothing replaces it, or a link from an earlier pass
      // survives into a probe aimed at live state. Asked of the install, never
      // the scratch: a box without a legacy store never grows one.
      rmSync(join(dir, name), { recursive: true, force: true });
      if (existsSync(join(home, name)))
        links.push([name, join(stateHome, name)]);
    }
    for (const [, target] of links) mkdirSync(target, { recursive: true });
    // The .env is the installation's in both modes: a probe under a configuration
    // nobody runs proves nothing, and `iva config` writes through to the real file.
    links.push([".env", layout.env]);
    for (const [name, target] of links) {
      const link = join(dir, name);
      rmSync(link, { recursive: true, force: true });
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
    }
  }

  /**
   * State for a probe: a real start re-enqueues what the installation is doing.
   * Beside the versions, never inside the one being proved, or a kill mid-check
   * hands the next sweep a good version to delete.
   */
  function sandboxState(name: string): string {
    const scratch = join(home, `.probe-${process.pid}-${Date.now()}`);
    linkState(versionDir(name), scratch);
    return scratch;
  }

  return {
    layout,
    list,
    currentName,
    previousName,
    nextBuild,
    stage,
    reset,
    complete,
    activate,
    settled,
    settle,
    sweep,
    gc,
    heal,
    materialize,
    linkState,
    sandboxState,
  };
}

/** A JSON file that may be missing or corrupt; an unreadable one is empty. */
export function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (parsed as Record<string, unknown> | null) ?? {};
  } catch {
    return {};
  }
}

/** Written through a rename, so a reader never sees half a marker. */
export function writeJson(path: string, body: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export type UpdateLock = { readonly path: string; release(): void };

function ownerPid(path: string): number | undefined {
  const pid = readJson(join(path, "owner.json")).pid;
  return typeof pid === "number" ? pid : undefined;
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Write down who holds the lock; only that process may drop it again. */
function own(path: string): UpdateLock {
  const startedAt = new Date().toISOString();
  writeJson(join(path, "owner.json"), { pid: process.pid, startedAt });
  return {
    path,
    // Never another process's lock: a handoff ends with the successor holding it.
    release: () => {
      if (ownerPid(path) === process.pid)
        rmSync(path, { recursive: true, force: true });
    },
  };
}

/** Take over a held lock: the process that finishes an update is the one that owns it. */
export function adoptUpdateLock(dataDir: string): UpdateLock {
  const path = join(dataDir, LOCK);
  mkdirSync(path, { recursive: true });
  return own(path);
}

/**
 * Serialize updates with one atomic mkdir. A lock whose owner is gone is stale at
 * once - a SIGKILLed update must not block the retry cleaning up after it - and
 * age is only the fallback for an owner that cannot be read.
 */
export function acquireUpdateLock(dataDir: string): UpdateLock | null {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK);
  const claim = (): UpdateLock => {
    mkdirSync(path);
    return own(path);
  };
  try {
    return claim();
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "EEXIST") throw caught;
  }
  const pid = ownerPid(path);
  if (alive(pid)) return null;
  if (pid === undefined) {
    // No readable owner: age is all that is left to tell live from abandoned.
    let age: number;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      return null;
    }
    if (age < STALE_MS) return null;
  }
  rmSync(path, { recursive: true, force: true });
  try {
    return claim();
  } catch {
    return null; // Another retry won the race for the same abandoned lock.
  }
}
