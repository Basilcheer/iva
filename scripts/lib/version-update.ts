import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isAuthoredPath } from "./authored-paths.ts";
import {
  portWasTaken,
  probeEnvironment,
  probeVersion,
} from "./health-probe.ts";
import { runMigrations } from "./migrations.ts";
import { DEFAULT_PORT, PortChecker, PortSelector, bindProbe } from "./ports.ts";
import { acquireUpdateLock } from "./update-lock.ts";
import {
  createVersionStore,
  parseVersionName,
  releaseOf,
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
  /** `--force`: build this release again, even where a build of it already runs. */
  readonly force?: boolean;
  /**
   * Hands the staged version over to the code that version ships, so that a fix
   * to the second half of an update arrives with the release that contains it.
   */
  readonly handoff?: (name: string) => Promise<UpdateOutcome>;
};

/**
 * The files the user authored, as paths relative to `data/custom`.
 *
 * Only the authored paths: the rest of that directory is the custom layer's own
 * bookkeeping - the manifest, base blobs, recovery bundles - and copying it into
 * the version would both lie about how much was customized and, for anything
 * under `data/`, write straight through a state symlink into the installation
 * that is still running.
 */
function customFiles(customDir: string): string[] {
  try {
    return readdirSync(customDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(relative(customDir, entry.parentPath), entry.name)
          .split(sep)
          .join("/"),
      )
      .filter(isAuthoredPath)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The overlay to build into a version: the authored files, plus a digest that
 * changes whenever any of them does.
 *
 * The digest is what gives a customization an identity of its own, so that
 * editing `data/custom` produces a version to build instead of resolving to the
 * one that already runs.
 */
export function customOverlay(customDir: string): {
  files: string[];
  digest: string | null;
} {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const path of customFiles(customDir)) {
    let body: Buffer;
    try {
      body = readFileSync(join(customDir, path));
    } catch {
      // Deleted between the listing and the read: it is not part of the overlay.
      continue;
    }
    files.push(path);
    hash.update(`${path}\0${body.length}\0`);
    hash.update(body);
  }
  return {
    files,
    digest: files.length > 0 ? hash.digest("hex").slice(0, 8) : null,
  };
}

/** What a version already on disk was built with, judged by what is in its tree. */
export function builtWith(
  dir: string,
  name: string,
  customDir: string,
): "none" | "applied" | "stock" {
  if (!parseVersionName(name)?.overlay) return "none";
  const files = customFiles(customDir);
  return files.length > 0 && files.every((path) => existsSync(join(dir, path)))
    ? "applied"
    : "stock";
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
    force = false,
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
    // The customization is half of what gets built, so it is half of what the
    // version is called. Edited while an update is in flight, the digest simply
    // differs again on the next run, which is one more update - never a version
    // that quietly disagrees with `data/custom` forever.
    const { digest } = customOverlay(join(store.layout.data, "custom"));
    const release = versionName(target.version, target.sha, digest);
    const active = store.currentName();
    // Nothing to do only once the installation has finished moving onto it. A flip
    // whose migrations, restart or layout changes never happened is an update
    // still owed, and reporting it as done is what strands an installation - and
    // `--force` is how somebody says the version that runs is broken anyway.
    if (
      !force &&
      active &&
      releaseOf(active) === release &&
      store.settled() === active
    ) {
      store.gc(KEEP);
      return { status: "current", version: active };
    }

    // A build of this release that is already finished is reused - that is what
    // makes taking a customization back out a symlink flip rather than a build.
    // `--force` is the one thing that refuses it: it is how somebody says the
    // build on disk is broken, so it gets a fresh directory instead of a rebuild
    // of the tree the service is running from.
    const finished = force
      ? undefined
      : store.list().find((entry) => releaseOf(entry.name) === release);
    const name = finished?.name ?? store.nextBuild(release);
    if (!finished) {
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
    // After a handoff the child has adopted this lock and already dropped it;
    // release only removes a lock this process still owns, so the pair is safe in
    // either order and in both processes.
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
  let custom = builtWith(dir, name, join(store.layout.data, "custom"));
  /**
   * Nothing points at a version being built, so a failure leaves only garbage -
   * and megabytes of it on a small disk.
   */
  const discardOnFailure = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  };
  const prove = async (): Promise<{ ok: boolean; log: string }> => {
    // The probe is a real server start, so it runs on scratch state: an update
    // that is about to be thrown away must not have touched the installation.
    const scratch = store.sandboxState(name);
    try {
      return await proveStarts(dir, check, log);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  // Either already running, or built and finished by a run that never got to
  // activate it. Both mean the tree is there and only what follows is owed.
  const prepared = store.list().some((entry) => entry.name === name);
  if (active === name) {
    // The flip happened, the rest did not: pick the update up where it stopped.
    log(`finishing the move onto ${name}`);
  } else {
    if (prepared) log(`reusing prepared version ${name}`);
    else
      custom = await discardOnFailure(() =>
        buildVersion({ store, name, dir, run, notify, log }),
      );
    let health = await prove();
    // A green build is not a start: the service compiles the authored TypeScript
    // again when it comes up, so a customization can pass the build and still
    // bring the service down. That is the user's code failing, and a release must
    // not be held hostage to it - so the same version is rebuilt without it.
    if (!health.ok && custom === "applied" && !prepared) {
      log(
        "the customized version does not start; building it without the overlay",
      );
      await discardOnFailure(() => buildStock({ store, name, dir, run }));
      custom = "stock";
      const broken = health.log;
      health = await prove();
      if (health.ok)
        notify(
          `your customization in data/custom does not start against this version, so Iva is running the stock build:\n${broken.slice(-1500)}`,
        );
    }
    if (!health.ok) {
      // A candidate this run built is garbage nothing points at, so removing it
      // is the whole rollback. A version that was already finished before this
      // run is somebody's way back - the target of a downgrade, or the stock
      // version left on disk when a customization is taken out again - and a
      // failed probe is not a licence to take it off the disk.
      if (!prepared) rmSync(dir, { recursive: true, force: true });
      notify(
        `update to ${name} did not start; staying on ${active ?? "the current version"}`,
      );
      return { status: "unhealthy", version: name, log: health.log };
    }
    // Proved: activating it is what lets it see the installation's own state.
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

async function install(dir: string, run: Runner): Promise<void> {
  const installed = await run("npm", ["ci", "--no-audit", "--no-fund"], dir);
  if (installed.code !== 0)
    throw new Error(`dependency installation failed:\n${installed.output}`);
}

/** Build the tree in place; returns what the build said when it refused to. */
async function build(dir: string, run: Runner): Promise<string | null> {
  const built = await run("npm", ["run", "build"], dir);
  return built.code === 0 ? null : built.output;
}

/** Install and build a tree in place, refusing to go on with a broken one. */
async function compile(dir: string, run: Runner): Promise<void> {
  await install(dir, run);
  const failure = await build(dir, run);
  if (failure) throw new Error(`build failed:\n${failure}`);
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
  await install(dir, run);
  const customDir = join(store.layout.data, "custom");
  const { files } = customOverlay(customDir);
  const failIfBroken = (failure: string | null): void => {
    if (failure) throw new Error(`build failed:\n${failure}`);
  };
  if (files.length === 0) {
    failIfBroken(await build(dir, run));
    return "none";
  }

  for (const relativePath of files) {
    // Confined to the version by `isAuthoredPath`: it rejects anything absolute,
    // anything that climbs out with `..`, and everything outside `agent/`.
    const target = join(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(customDir, relativePath), target);
  }
  log(`applied ${files.length} customized file(s)`);
  const failure = await build(dir, run);
  if (!failure) return "applied";

  // The user's own code must never keep the service down: rebuild the stock tree in
  // place and say so. The customization stays untouched in data/custom.
  log("the customized build failed; building this version without the overlay");
  await buildStock({ store, name, dir, run });
  notify(
    `your customization in data/custom does not build against this version, so Iva is running the stock build:\n${failure.slice(-1500)}`,
  );
  return "stock";
}

/**
 * Rebuild a staged version from its commit alone, dropping the overlay.
 *
 * The directory keeps the name it was staged under - customization included - so
 * that a customization known not to work here is tried once, not on every update
 * until the user changes it.
 */
async function buildStock({
  store,
  name,
  dir,
  run,
}: {
  store: Store;
  name: string;
  dir: string;
  run: Runner;
}): Promise<void> {
  store.reset(name);
  await store.materialize({ sha: parseVersionName(name)?.sha ?? "", dir });
  store.linkState(dir);
  await compile(dir, run);
}
