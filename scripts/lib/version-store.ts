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
/**
 * What a version borrows from the installation instead of owning. Only eve's
 * durable store is shared out of `.eve`: the rest is a build cache keyed by the
 * code, so it belongs to the version that built it.
 */
export const STATE_DIRS = ["data", "vault", ".eve/.workflow-data"];
/** Where older builds kept the workflow store: linked where one is, never created. */
export const LEGACY_STATE_DIRS = [".workflow-data"];
const FLIP_PREFIX = ".current.iva-flip-";
/** Names in `home` that only an interrupted update can leave behind. */
const LEFTOVER_PREFIXES = [FLIP_PREFIX, ".probe-"];
const VERSION_NAME =
  /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-([0-9a-f]{12})(?:\+([0-9a-f]{8}))?(?:~(\d+))?$/;

export type Layout = ReturnType<typeof layoutFor>;

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

/**
 * A release, the commit it was built from, and - where the user has customized
 * the installation - a digest of the files they wrote, because those are part of
 * the tree that gets built. `build` numbers directories holding the same code, so
 * `--force` can install a release again beside the one that runs.
 */
export function versionName(
  version: string,
  sha: string,
  overlay: string | null = null,
  build = 1,
): string {
  const suffix = build > 1 ? `~${build}` : "";
  return `${version}-${sha.slice(0, 12)}${overlay ? `+${overlay}` : ""}${suffix}`;
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
  const parsed = parseVersionName(name);
  return parsed
    ? versionName(parsed.version, parsed.sha, parsed.overlay)
    : name;
}

/**
 * Immutable version directories plus one symlink that says which of them runs.
 * Every mutation is confined to a directory nothing points at yet, or is a single
 * atomic rename, so an interruption leaves garbage and never a half-changed
 * installation.
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
  function list(): { name: string; dir: string; mtimeMs: number }[] {
    return names()
      .filter((name) => parseVersionName(name) && isComplete(name))
      .map((name) => {
        const dir = join(layout.versions, name);
        return { name, dir, mtimeMs: statSync(dir).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  }

  /** The active version, or null when the link is missing, dangling or foreign. */
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
    return list().find((entry) => entry.name !== active)?.name ?? null;
  }

  /**
   * A free directory name for the next build of a release: `--force` rebuilds the
   * way everything is installed, beside the running version and never inside it.
   */
  function nextBuild(release: string): string {
    const parsed = parseVersionName(release);
    if (!parsed) throw new Error(`invalid version: ${release}`);
    for (let build = 1; build <= 99; build++) {
      const { version, sha, overlay } = parsed;
      const name = versionName(version, sha, overlay, build);
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
    // Whatever a killed probe left the links pointing at, a version about to run
    // gets the installation's own state back.
    linkState(dir);
    const flip = join(home, `${FLIP_PREFIX}${process.pid}-${Date.now()}`);
    rmSync(flip, { recursive: true, force: true });
    symlinkSync(dir, flip);
    try {
      // rename() replaces a symlink atomically; anything else there is not ours to keep.
      if (
        existsSync(layout.current) &&
        !lstatSync(layout.current).isSymbolicLink()
      )
        rmSync(layout.current, { recursive: true, force: true });
      renameSync(flip, layout.current);
    } catch (error) {
      rmSync(flip, { recursive: true, force: true });
      throw error;
    }
  }

  /** Flipped, migrated, restarted: an update is owed while this and `current` disagree. */
  function settled(): string | null {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(layout.data, SETTLED), "utf8"),
      );
      const name = (parsed as { version?: unknown } | null)?.version;
      return typeof name === "string" ? name : null;
    } catch {
      return null;
    }
  }

  /** Written last in an update, so an interrupted one is replayed rather than lost. */
  function settle(name: string): void {
    mkdirSync(layout.data, { recursive: true });
    const marker = join(layout.data, SETTLED);
    const temp = `${marker}.${process.pid}.tmp`;
    const body = JSON.stringify({ schema: "iva-active/v1", version: name });
    writeFileSync(temp, `${body}\n`, { mode: 0o600 });
    renameSync(temp, marker);
  }

  /** Remove what an interrupted update can leave behind. Never touches a version. */
  function sweep(): string[] {
    const stale = names().filter(
      (name) => parseVersionName(name) && !isComplete(name),
    );
    for (const name of stale)
      rmSync(join(layout.versions, name), { recursive: true, force: true });
    for (const name of readdirSync(home).sort()) {
      if (!LEFTOVER_PREFIXES.some((prefix) => name.startsWith(prefix)))
        continue;
      rmSync(join(home, name), { recursive: true, force: true });
      stale.push(name);
    }
    return stale;
  }

  /** Keep the active version plus the newest others; disks on these boxes are small. */
  function gc(keep: number): string[] {
    const active = currentName();
    const kept = new Set(active ? [active] : []);
    for (const entry of list()) {
      if (kept.size >= Math.max(keep, 1)) break;
      kept.add(entry.name);
    }
    const removed = list()
      .filter((entry) => !kept.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of removed)
      rmSync(join(layout.versions, name), { recursive: true, force: true });
    return removed;
  }

  /** Make `current` valid again after a manual edit or a crash. */
  function heal(): string | null {
    const active = currentName();
    if (active) return active;
    // The version last settled on, not the newest on disk: after a rollback the
    // newest is the version that was rejected, and healing must not restore it.
    const chosen = settled();
    const pick = list().find((entry) => entry.name === chosen) ?? list()[0];
    if (!pick) return null;
    activate(pick.name);
    return pick.name;
  }

  /** Fill a staged directory with the exact tree of one commit, without git state. */
  async function materialize({
    sha,
    dir,
  }: {
    sha: string;
    dir: string;
  }): Promise<void> {
    await Promise.resolve();
    const archive = join(dir, ".iva-archive.tar");
    const step = (command: string, args: string[], cwd: string): void => {
      const done = spawnSync(command, args, { cwd, encoding: "utf8" });
      const failure = done.error?.message ?? (done.stderr || "").trim();
      if (done.error || done.status !== 0)
        throw new Error(`materialize failed: ${failure || command}`);
    };
    try {
      // Through a file rather than a pipe: two processes joined by a stream is a
      // second failure mode (and a kill of either end) for no gain here.
      const output = `--output=${archive}`;
      step("git", ["archive", "--format=tar", output, sha], layout.repo);
      step("tar", ["-x", "-f", archive], dir);
    } finally {
      rmSync(archive, { force: true });
    }
  }

  /**
   * State lives outside the versions tree; a version only borrows it. `stateHome`
   * is the installation for a version that runs, and a scratch directory while
   * one is only being proved - see `sandboxState`.
   */
  function linkState(dir: string, stateHome: string = home): void {
    const links: [string, string][] = STATE_DIRS.map((name) => [
      name,
      join(stateHome, name),
    ]);
    for (const name of LEGACY_STATE_DIRS) {
      // Cleared even where nothing replaces it, or a link from an earlier pass
      // survives into a probe still pointing at live state. Asked of the
      // installation, never of a probe's scratch: a box without a legacy store
      // must not grow an empty one in either place.
      rmSync(join(dir, name), { recursive: true, force: true });
      if (existsSync(join(home, name)))
        links.push([name, join(stateHome, name)]);
    }
    for (const [, target] of links) mkdirSync(target, { recursive: true });
    // The .env is the installation's in both modes: reading it is what makes a
    // probe meaningful, and `iva config` has to write through to the real file.
    links.push([".env", layout.env]);
    for (const [name, target] of links) {
      const link = join(dir, name);
      rmSync(link, { recursive: true, force: true });
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
    }
  }

  /**
   * Point a version's state at scratch directories while its probe runs: the probe
   * starts the real server, which would otherwise re-enqueue the runs the live
   * service is handling. The scratch lives beside the versions, never inside the
   * one being proved, so a kill during a check cannot hand the next sweep a good
   * version to delete.
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
