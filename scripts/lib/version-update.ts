import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { portWasTaken, probeEnvironment, probeVersion } from "./health-probe.ts";
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
  | { status: "failed"; message: string }
  | {
      status: "updated";
      version: string;
      previous: string | null;
      custom: "none" | "applied" | "stock";
      migrations: string[];
      removed: string[];
    };

type Store = ReturnType<typeof createVersionStore>;

/** The active version plus one to roll back to; disks on these boxes are small. */
const KEEP = 2;

type FinishOptions = {
  readonly home: string;
  /** The staged version to build, prove and activate. */
  readonly name: string;
  readonly run: Runner;
  readonly probe?: (
    dir: string,
    port: number,
  ) => Promise<{ ok: boolean; log: string }>;
  readonly restart?: (root: string) => Promise<void>;
  /** Layout changes the installation itself needs: the shim, the old checkout. */
  readonly adopt?: () => void;
  readonly notify?: (message: string) => void;
  readonly log?: (message: string) => void;
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
  try {
    return readdirSync(customDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(relative(customDir, entry.parentPath), entry.name)
          .split(sep)
          .join("/"),
      )
      .sort();
  } catch {
    return [];
  }
}

/**
 * Prove the version starts, from its own directory, on a port nothing else holds.
 *
 * The port is chosen and then taken, so another process can win the race in
 * between; that says nothing about the version, so it is worth another port
 * rather than a verdict.
 */
async function proveStarts(
  dir: string,
  probe: (dir: string, port: number) => Promise<{ ok: boolean; log: string }>,
  log: (message: string) => void,
): Promise<{ ok: boolean; log: string }> {
  // Bind is the only probe worth asking here: the docker probe shells out and can
  // block for a long time on a host whose daemon is unreachable.
  const selector = new PortSelector(new PortChecker([bindProbe]));
  // Two updaters on one box would otherwise scan from the same port and keep
  // colliding on it; the pid spreads them apart without any coordination.
  let start = DEFAULT_PORT + 100 + (process.pid % 100);
  let health = { ok: false, log: "the version was never started" };
  for (let attempt = 1; attempt <= 5; attempt++) {
    const port = (await selector.firstFree(start)) ?? start;
    health = await probe(dir, port);
    if (health.ok || !portWasTaken(health.log)) break;
    log(`probe port ${port} was taken; retrying above it`);
    start = port + 1;
  }
  return health;
}

/**
 * One update, expressed as: build a new immutable version, prove it starts, flip
 * a symlink, then move the installation onto it.
 *
 * Nothing before the flip touches the running version, so an interruption there
 * leaves it exactly as it was and costs the next run a sweep. Nothing after the
 * flip is allowed to be a one-shot either: the next run replays whatever did not
 * finish, because an installation half moved is the one state with no way out.
 */
export async function runVersionUpdate(
  options: VersionUpdateOptions,
): Promise<UpdateOutcome> {
  const {
    home,
    resolveTarget,
    handoff,
    log = () => {},
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
    // Nothing to do only once the installation has finished moving onto it. A flip
    // whose migrations, restart or layout changes never happened is an update
    // still owed, and reporting it as done is what strands an installation.
    if (name === store.currentName() && store.settled() === name) {
      store.gc(KEEP);
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
 *
 * Two commit points, both replayable. The flip decides which code runs; the
 * settle marker decides whether the installation has finished moving onto it.
 * Everything between them is written to be safe to run twice, because a crash
 * there means the next `iva update` runs it again.
 */
export async function finishVersionUpdate({
  home,
  name,
  run,
  probe,
  restart = async () => {},
  adopt = () => {},
  notify = () => {},
  log = () => {},
  store = createVersionStore(home),
}: FinishOptions): Promise<UpdateOutcome> {
  const dir = join(store.layout.versions, name);
  const active = store.currentName();
  const check =
    probe ??
    ((target: string, port: number) =>
      probeVersion({
        dir: target,
        port,
        env: probeEnvironment(store.layout.env, port),
      }));
  let custom: "none" | "applied" | "stock" = "none";

  if (active === name) {
    // The flip happened, the rest did not: pick the update up where it stopped.
    log(`finishing the move onto ${name}`);
  } else {
    if (store.list().some((entry) => entry.name === name)) {
      // A previous run built and finished this version but never got to activate it.
      log(`reusing prepared version ${name}`);
    } else {
      try {
        custom = await buildVersion({ store, name, dir, run, notify, log });
      } catch (error) {
        // A failed build is worth megabytes on a small disk, and nothing points at it.
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    }
    // The probe is a real server start, so it runs on scratch state: an update
    // that is about to be thrown away must not have touched the installation.
    store.sandboxState(name);
    const health = await proveStarts(dir, check, log);
    if (!health.ok) {
      // Nothing points at it, so removing it is the whole rollback.
      rmSync(dir, { recursive: true, force: true });
      notify(
        `update to ${name} did not start; staying on ${active ?? "the current version"}`,
      );
      return { status: "unhealthy", version: name, log: health.log };
    }
    // Proved: from here the version is allowed to see the installation's state.
    store.linkState(dir);
    store.complete(name);
    store.activate(name);
  }

  // Before the restart: the service must never open state that the new version
  // still expects to migrate.
  const migrations = await runMigrations({
    dir: join(dir, "scripts/migrations"),
    dataDir: store.layout.data,
    context: { home, dataDir: store.layout.data, versionDir: dir },
    log,
  });
  await restart(store.layout.current);
  // After the restart: until the service runs the new version, the old checkout
  // is still what a failed restart falls back to, so it is not ours to remove yet.
  adopt();
  const removed = store.gc(KEEP);
  store.settle(name);
  return {
    status: "updated",
    version: name,
    previous: active === name ? null : active,
    custom,
    migrations,
    removed,
  };
}

async function buildVersion({
  store,
  name,
  dir,
  run,
  notify,
  log,
}: {
  store: Store;
  name: string;
  dir: string;
  run: Runner;
  notify: (message: string) => void;
  log: (message: string) => void;
}): Promise<"none" | "applied" | "stock"> {
  const npm = "npm";
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
