import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { probeVersion } from "./health-probe.ts";
import { runMigrations } from "./migrations.ts";
import { DEFAULT_PORT, PortChecker, PortSelector, bindProbe } from "./ports.ts";
import { acquireUpdateLock } from "./update-lock.ts";
import {
  createVersionStore,
  parseVersionName,
  versionName,
} from "./version-store.ts";

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

type Store = ReturnType<typeof createVersionStore>;

type FinishOptions = {
  readonly home: string;
  /** The staged version to build, prove and activate. */
  readonly name: string;
  readonly run: Runner;
  readonly npm?: string;
  readonly probe?: (
    dir: string,
    port: number,
  ) => Promise<{ ok: boolean; log: string }>;
  readonly restart?: (root: string) => Promise<void>;
  readonly notify?: (message: string) => void;
  readonly log?: (message: string) => void;
  readonly keep?: number;
  readonly store?: Store;
};

export type VersionUpdateOptions = Omit<FinishOptions, "name"> & {
  /** Fetches into the mirror and reports what should run next. */
  readonly resolveTarget: () => Promise<{ sha: string; version: string }>;
  /**
   * Hands the staged version over to the code that version ships, so that a fix
   * to the second half of an update arrives with the release that contains it.
   */
  readonly handoff?: (name: string) => Promise<UpdateOutcome>;
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

/**
 * One update, expressed as: build a new immutable version, prove it starts, then
 * flip a symlink. Nothing here mutates the running version, so an interruption at
 * any point leaves it exactly as it was and only costs the next run a sweep.
 */
export async function runVersionUpdate(
  options: VersionUpdateOptions,
): Promise<UpdateOutcome> {
  const {
    home,
    resolveTarget,
    handoff,
    log = () => {},
    keep = 2,
    store = createVersionStore(home),
  } = options;
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

    if (!store.list().some((entry) => entry.name === name)) {
      const dir = store.stage(name);
      try {
        await store.materialize({ sha: target.sha, dir });
        store.linkState(dir);
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    }
    return handoff
      ? await handoff(name)
      : await finishVersionUpdate({ ...options, name, store });
  } finally {
    lock.release();
  }
}

/**
 * The half of an update that the new version runs about itself: install, build,
 * prove, flip, migrate, restart. Split out so it can be executed by the code that
 * was just fetched instead of the code that is being replaced.
 */
export async function finishVersionUpdate({
  home,
  name,
  run,
  npm = "npm",
  probe = (dir, port) => probeVersion({ dir, port }),
  restart = async () => {},
  notify = () => {},
  log = () => {},
  keep = 2,
  store = createVersionStore(home),
}: FinishOptions): Promise<UpdateOutcome> {
  const dir = join(store.layout.versions, name);
  const previous = store.currentName();
  let custom: "none" | "applied" | "stock" = "none";
  if (store.list().some((entry) => entry.name === name)) {
    // A previous run built and finished this version but never got to activate it.
    log(`reusing prepared version ${name}`);
  } else {
    try {
      custom = await buildVersion({ store, name, dir, run, npm, notify, log });
    } catch (error) {
      // A failed build is worth megabytes on a small disk, and nothing points at it.
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
  // Before the restart: the service must never open state that the new version
  // still expects to migrate.
  const migrations = await runMigrations({
    dir: join(dir, "scripts/migrations"),
    dataDir: store.layout.data,
    context: { home, dataDir: store.layout.data, versionDir: dir },
    log,
  });
  await restart(store.layout.current);
  const removed = store.gc(keep);
  return { status: "updated", version: name, previous, custom, migrations, removed };
}

async function buildVersion({
  store,
  name,
  dir,
  run,
  npm,
  notify,
  log,
}: {
  store: Store;
  name: string;
  dir: string;
  run: Runner;
  npm: string;
  notify: (message: string) => void;
  log: (message: string) => void;
}): Promise<"none" | "applied" | "stock"> {
  const install = async (): Promise<void> => {
    const installed = await run(npm, ["ci", "--no-audit", "--no-fund"], dir);
    if (installed.code !== 0)
      throw new Error(`dependency installation failed:\n${installed.output}`);
  };
  await install();

  const customDir = join(store.layout.data, "custom");
  const overlay = customFiles(customDir);
  if (overlay.length === 0) {
    const built = await run(npm, ["run", "build"], dir);
    if (built.code !== 0) throw new Error(`build failed:\n${built.output}`);
    return "none";
  }

  for (const relativePath of overlay) {
    const target = resolve(dir, relativePath);
    if (!target.startsWith(`${resolve(dir)}${sep}`))
      throw new Error(`custom file escapes the version: ${relativePath}`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(customDir, relativePath), target);
  }
  log(`applied ${overlay.length} customized file(s)`);
  const customized = await run(npm, ["run", "build"], dir);
  if (customized.code === 0) return "applied";

  // The user's own code must never keep the service down: rebuild the stock tree in
  // place and say so. The customization stays untouched in data/custom.
  log("customized build failed; falling back to the stock build");
  const sha = parseVersionName(name)?.sha ?? "";
  store.reset(name);
  await store.materialize({ sha, dir });
  store.linkState(dir);
  await install();
  const stock = await run(npm, ["run", "build"], dir);
  if (stock.code !== 0) throw new Error(`build failed:\n${stock.output}`);
  notify(
    `your customization in data/custom does not build against this version, so Iva is running the stock build:\n${customized.output.slice(-1500)}`,
  );
  return "stock";
}
