import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { probeVersion } from "./health-probe.ts";
import { runMigrations } from "./migrations.ts";
import { DEFAULT_PORT, PortChecker, PortSelector, bindProbe } from "./ports.ts";
import { acquireUpdateLock } from "./update-lock.ts";
import { createVersionStore, versionName } from "./version-store.ts";

export type CommandResult = { readonly code: number; readonly output: string };
export type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

export type UpdateOutcome =
  | { status: "busy" }
  | { status: "current"; version: string }
  | { status: "unhealthy"; version: string; log: string }
  | {
      status: "updated";
      version: string;
      previous: string | null;
      custom: "none" | "applied" | "stock";
      migrations: string[];
      removed: string[];
    };

export type VersionUpdateOptions = {
  readonly home: string;
  /** Fetches into the mirror and reports what should run next. */
  readonly resolveTarget: () => Promise<{ sha: string; version: string }>;
  readonly run: Runner;
  readonly npm?: string;
  readonly probe?: (
    dir: string,
    port: number,
  ) => Promise<{ ok: boolean; log: string }>;
  readonly restart?: (dir: string) => Promise<void>;
  readonly notify?: (message: string) => void;
  readonly log?: (message: string) => void;
  readonly keep?: number;
};

/** Every regular file under `data/custom`, as paths relative to it. */
function customFiles(customDir: string): string[] {
  const walk = (relativeDir: string): string[] => {
    const base = join(customDir, relativeDir);
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      const child = relativeDir ? join(relativeDir, name) : name;
      return statSync(join(base, name)).isDirectory()
        ? walk(child)
        : [child.split(sep).join("/")];
    });
  };
  return walk("").sort();
}

function insideVersion(dir: string, relativePath: string): string {
  const target = resolve(dir, relativePath);
  if (!target.startsWith(`${resolve(dir)}${sep}`))
    throw new Error(`custom file escapes the version: ${relativePath}`);
  return target;
}

/**
 * One update, expressed as: build a new immutable version, prove it starts, then
 * flip a symlink. Nothing here mutates the running version, so an interruption at
 * any point leaves it exactly as it was and only costs the next run a sweep.
 */
export async function runVersionUpdate({
  home,
  resolveTarget,
  run,
  npm = "npm",
  probe = (dir, port) => probeVersion({ dir, port }),
  restart = async () => {},
  notify = () => {},
  log = () => {},
  keep = 2,
}: VersionUpdateOptions): Promise<UpdateOutcome> {
  const store = createVersionStore(home);
  const lock = acquireUpdateLock(store.layout.data);
  if (!lock) return { status: "busy" };
  try {
    // Safe only under the lock: leftovers are garbage exactly because nobody owns them.
    for (const stale of store.sweep()) log(`removed leftover ${stale}`);
    store.heal();

    const target = await resolveTarget();
    const name = versionName(target.version, target.sha);
    if (name === store.currentName()) {
      store.gc(keep);
      return { status: "current", version: name };
    }

    const previous = store.currentName();
    const ready = store.list().some((entry) => entry.name === name);
    let custom: "none" | "applied" | "stock" = "none";
    let dir = join(store.layout.versions, name);
    if (ready) {
      // A previous run built and finished this version but never got to activate it.
      log(`reusing prepared version ${name}`);
    } else {
      dir = store.stage(name);
      try {
        custom = await buildVersion({
          store,
          name,
          dir,
          sha: target.sha,
          run,
          npm,
          notify,
          log,
        });
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    }

    // Bind is the only probe worth asking here: the docker probe shells out and can
    // block for a long time on a host whose daemon is unreachable.
    const port =
      (await new PortSelector(new PortChecker([bindProbe])).firstFree(
        DEFAULT_PORT + 100,
      )) ?? DEFAULT_PORT + 100;
    const health = await probe(dir, port);
    if (!health.ok) {
      // Nothing points at it, so removing it is the whole rollback.
      rmSync(dir, { recursive: true, force: true });
      notify(
        `update to ${name} did not start; staying on ${previous ?? "the current version"}`,
      );
      return { status: "unhealthy", version: name, log: health.log };
    }

    store.complete(name);
    store.activate(name);
    await restart(dir);
    const migrations = await runMigrations({
      dir: join(dir, "scripts/migrations"),
      dataDir: store.layout.data,
      context: { home, dataDir: store.layout.data, versionDir: dir },
      log,
    });
    const removed = store.gc(keep);
    return {
      status: "updated",
      version: name,
      previous,
      custom,
      migrations,
      removed,
    };
  } finally {
    lock.release();
  }
}

async function buildVersion({
  store,
  name,
  dir,
  sha,
  run,
  npm,
  notify,
  log,
}: {
  store: ReturnType<typeof createVersionStore>;
  name: string;
  dir: string;
  sha: string;
  run: Runner;
  npm: string;
  notify: (message: string) => void;
  log: (message: string) => void;
}): Promise<"none" | "applied" | "stock"> {
  const materialize = async (): Promise<void> => {
    await store.materialize({ sha, dir });
    store.linkState(dir);
    const installed = await run(npm, ["ci", "--no-audit", "--no-fund"], dir);
    if (installed.code !== 0)
      throw new Error(`dependency installation failed:\n${installed.output}`);
  };
  await materialize();

  const overlay = customFiles(join(store.layout.data, "custom"));
  if (overlay.length === 0) {
    const built = await run(npm, ["run", "build"], dir);
    if (built.code !== 0) throw new Error(`build failed:\n${built.output}`);
    return "none";
  }

  for (const relativePath of overlay) {
    const target = insideVersion(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(store.layout.data, "custom", relativePath), target);
  }
  log(`applied ${overlay.length} customized file(s)`);
  const customized = await run(npm, ["run", "build"], dir);
  if (customized.code === 0) return "applied";

  // The user's own code must never keep the service down: rebuild the stock tree in
  // place and say so. The customization stays untouched in data/custom.
  log("customized build failed; falling back to the stock build");
  store.reset(name);
  await materialize();
  const stock = await run(npm, ["run", "build"], dir);
  if (stock.code !== 0) throw new Error(`build failed:\n${stock.output}`);
  notify(
    `your customization in data/custom does not build against this version, so Iva is running the stock build:\n${customized.output.slice(-1500)}`,
  );
  return "stock";
}
