import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

const INCOMPLETE = ".iva-incomplete";
const FLIP_PREFIX = ".current.iva-flip-";
const VERSION_NAME = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-([0-9a-f]{12})$/;

export type Layout = {
  /** Installation root, the only path a user ever has to know. */
  readonly home: string;
  /** Git mirror the updater fetches into; never the tree anything runs from. */
  readonly repo: string;
  readonly versions: string;
  readonly current: string;
  readonly data: string;
  readonly vault: string;
  readonly env: string;
};

export type VersionEntry = {
  readonly name: string;
  readonly dir: string;
  readonly mtimeMs: number;
};

export function layoutFor(home: string): Layout {
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

export function versionName(version: string, sha: string): string {
  return `${version}-${sha.slice(0, 12)}`;
}

export function parseVersionName(
  name: string,
): { version: string; sha: string } | null {
  const match = VERSION_NAME.exec(name);
  return match ? { version: match[1], sha: match[2] } : null;
}

function pipe(
  producer: { command: string; args: string[]; cwd: string },
  consumer: { command: string; args: string[]; cwd: string },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stderr = "";
    let pending = 2;
    const fail = (message: string) =>
      reject(new Error(`materialize failed: ${message.trim() || "unknown"}`));
    const settle = (code: number | null) => {
      if (code !== 0) return fail(stderr);
      if (--pending === 0) resolve();
    };
    const from = spawn(producer.command, producer.args, {
      cwd: producer.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const to = spawn(consumer.command, consumer.args, {
      cwd: consumer.cwd,
      stdio: ["pipe", "ignore", "pipe"],
    });
    for (const stream of [from.stderr, to.stderr])
      stream.on("data", (chunk: unknown) => {
        stderr += String(chunk);
      });
    from.on("error", (error) => fail(error.message));
    to.on("error", (error) => fail(error.message));
    from.stdout.pipe(to.stdin);
    from.on("close", settle);
    to.on("close", settle);
  });
}

/**
 * Immutable version directories plus one symlink that says which of them runs.
 *
 * Every mutation is either confined to a directory nothing points at yet, or a
 * single atomic rename, so an interrupted update can only ever leave garbage
 * behind - never a half-changed installation.
 */
export function createVersionStore(home: string) {
  const layout = layoutFor(home);

  const versionDir = (name: string): string => {
    if (!parseVersionName(name)) throw new Error(`invalid version: ${name}`);
    return join(layout.versions, name);
  };

  const isComplete = (name: string): boolean => {
    const dir = join(layout.versions, name);
    return existsSync(dir) && !existsSync(join(dir, INCOMPLETE));
  };

  function list(): VersionEntry[] {
    let names: string[];
    try {
      names = readdirSync(layout.versions);
    } catch {
      return [];
    }
    return names
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

  function currentDir(): string | null {
    const name = currentName();
    return name ? join(layout.versions, name) : null;
  }

  function previousName(): string | null {
    const active = currentName();
    return list().find((entry) => entry.name !== active)?.name ?? null;
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
    // Written last: a directory without it is a version, with it it is garbage.
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
    for (const entry of readdirSync(dir)) {
      if (entry === INCOMPLETE) continue;
      rmSync(join(dir, entry), { recursive: true, force: true });
    }
    return dir;
  }

  /** Point `current` at a finished version with one rename. */
  function activate(name: string): void {
    const dir = versionDir(name);
    if (!isComplete(name)) throw new Error(`version ${name} is incomplete`);
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

  /** Remove what an interrupted update can leave behind. Never touches a version. */
  function sweep(): string[] {
    const stale: string[] = [];
    let names: string[];
    try {
      names = readdirSync(layout.versions);
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      if (!parseVersionName(name) || isComplete(name)) continue;
      rmSync(join(layout.versions, name), { recursive: true, force: true });
      stale.push(name);
    }
    for (const name of readdirSync(home).sort()) {
      if (!name.startsWith(FLIP_PREFIX)) continue;
      rmSync(join(home, name), { recursive: true, force: true });
      stale.push(name);
    }
    return stale;
  }

  /** Keep the active version plus the newest others; disks on these boxes are small. */
  function gc(keep: number): string[] {
    const active = currentName();
    const keepNames = new Set(active ? [active] : []);
    for (const entry of list()) {
      if (keepNames.size >= Math.max(keep, 1)) break;
      keepNames.add(entry.name);
    }
    const removed = list()
      .filter((entry) => !keepNames.has(entry.name))
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
    const newest = list()[0];
    if (!newest) return null;
    activate(newest.name);
    return newest.name;
  }

  /** Fill a staged directory with the exact tree of one commit, without git state. */
  function materialize({
    sha,
    dir,
  }: {
    sha: string;
    dir: string;
  }): Promise<void> {
    return pipe(
      {
        command: "git",
        args: ["archive", "--format=tar", sha],
        cwd: layout.repo,
      },
      { command: "tar", args: ["-x", "-f", "-"], cwd: dir },
    );
  }

  /** State lives outside the versions tree; a version only borrows it. */
  function linkState(dir: string): void {
    mkdirSync(layout.data, { recursive: true });
    mkdirSync(layout.vault, { recursive: true });
    const links: [string, string][] = [
      ["data", layout.data],
      ["vault", layout.vault],
    ];
    if (existsSync(layout.env)) links.push([".env", layout.env]);
    for (const [name, target] of links) {
      const link = join(dir, name);
      rmSync(link, { recursive: true, force: true });
      symlinkSync(target, link);
    }
  }

  return {
    layout,
    list,
    currentName,
    currentDir,
    previousName,
    stage,
    reset,
    complete,
    activate,
    sweep,
    gc,
    heal,
    materialize,
    linkState,
  };
}
