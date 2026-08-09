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
import { DEFAULT_PORT } from "./ports.ts";
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

type Say = (message: string) => void;
type Health = { ok: boolean; log: string };
type Probe = (dir: string, port: number) => Promise<Health>;
/** Whether the user's own files are in the version that runs. */
type Custom = "none" | "applied" | "stock";
type Store = ReturnType<typeof createVersionStore>;

export type UpdateOutcome =
  | { status: "busy" }
  | { status: "current"; version: string }
  | { status: "unhealthy"; version: string; log: string }
  | { status: "failed"; message: string }
  | {
      status: "updated";
      version: string;
      previous: string | null;
      custom: Custom;
      migrations: string[];
      removed: string[];
    };

/** The active version plus one to roll back to; disks on these boxes are small. */
const KEEP = 2;
const INSTALL = ["ci", "--no-audit", "--no-fund"];
const BUILD = ["run", "build"];

type FinishOptions = {
  readonly home: string;
  /** The staged version to build, prove and activate. */
  readonly name: string;
  readonly run: Runner;
  readonly probe?: Probe;
  readonly restart?: (root: string) => Promise<void>;
  /** Layout changes the installation itself needs: the shim, the old checkout. */
  readonly adopt?: () => void;
  readonly notify?: Say;
  readonly log?: Say;
  readonly store?: Store;
};

type UpdateOptions = Omit<FinishOptions, "name"> & {
  /** Fetches into the mirror and reports what should run next. */
  readonly resolveTarget: () => Promise<{ sha: string; version: string }>;
  /** `--force`: build this release again, even where a build of it already runs. */
  readonly force?: boolean;
  /**
   * Hands the staged version to the code that version ships, so that a fix to the
   * second half of an update arrives with the release that carries it.
   */
  readonly handoff?: (name: string) => Promise<UpdateOutcome>;
};

/** The files the user authored, relative to `data/custom`; the rest of that
 * directory is the custom layer's own bookkeeping. */
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
 * The authored files plus a digest that changes whenever any of them does. The
 * digest is what makes an edit to `data/custom` a version to build instead of
 * the version that already runs.
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
      continue; // Deleted between the listing and the read.
    }
    files.push(path);
    hash.update(`${path}\0${body.length}\0`);
    hash.update(body);
  }
  const digest = files.length > 0 ? hash.digest("hex").slice(0, 8) : null;
  return { files, digest };
}

/** What a version already on disk was built with, judged by what is in its tree. */
export function builtWith(
  dir: string,
  name: string,
  customDir: string,
): Custom {
  if (!parseVersionName(name)?.overlay) return "none";
  const files = customFiles(customDir);
  return files.length > 0 && files.every((path) => existsSync(join(dir, path)))
    ? "applied"
    : "stock";
}

/**
 * Prove the version starts, from its own directory. A port taken between the
 * check and the start says nothing about the version, so it is worth another
 * port rather than a verdict; the probe itself is what recognises a busy one.
 */
async function proveStarts(
  dir: string,
  probe: Probe,
  log: Say,
): Promise<Health> {
  // The pid spreads two updaters on one box apart without any coordination.
  const first = DEFAULT_PORT + 100 + (process.pid % 100);
  let health: Health = { ok: false, log: "the version was never started" };
  for (let port = first; port < first + 5; port++) {
    health = await probe(dir, port);
    if (health.ok || !portWasTaken(health.log)) break;
    log(`probe port ${port} was taken; retrying above it`);
  }
  return health;
}

/**
 * One update: build a new immutable version, prove it starts, flip a symlink,
 * then move the installation onto it. Nothing before the flip touches the running
 * version, and nothing after it is a one-shot - the next run replays it, because
 * an installation half moved is the one state with no way out.
 */
export async function runVersionUpdate(
  options: UpdateOptions,
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
    // Safe only under the lock: leftovers are garbage because nobody owns them.
    for (const stale of store.sweep()) log(`removed leftover ${stale}`);
    store.heal();

    const target = await resolveTarget();
    // The customization is half of what gets built, so it is half of what the
    // version is called. Edited mid-update, the digest differs again next run.
    const { digest } = customOverlay(join(store.layout.data, "custom"));
    const release = versionName(target.version, target.sha, digest);
    const active = store.currentName();
    // Nothing to do only once the move is finished: a flip whose migrations,
    // restart or layout changes never ran is an update still owed.
    const settled =
      active && releaseOf(active) === release && store.settled() === active;
    if (settled && !force) {
      store.gc(KEEP);
      return { status: "current", version: active };
    }

    // Reusing a finished build of this release makes taking a customization back
    // out a flip rather than a build. `--force` refuses it: that build is broken.
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
    // After a handoff the child adopted this lock and dropped it; release only
    // removes a lock this process still owns, so both orders are safe.
    lock.release();
  }
}

/**
 * The half of an update the new version runs about itself: install, build, prove,
 * flip, migrate, restart - split out so the code just fetched runs it rather than
 * the code being replaced. Two commit points, both replayable: the flip decides
 * which code runs, the settle marker decides whether the move is finished.
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
  const check: Probe =
    probe ??
    ((target, port) =>
      probeVersion({
        dir: target,
        port,
        env: probeEnvironment(store.layout.env, port),
      }));
  const build = { store, name, dir, run, notify, log };
  let custom = builtWith(dir, name, join(store.layout.data, "custom"));
  /** A version being built is garbage nothing points at: a failure takes it away. */
  const discard = (error: unknown): never => {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  };
  const prove = async (): Promise<Health> => {
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
    else custom = await buildVersion(build).catch(discard);
    let health = await prove();
    // A green build is not a start: the service compiles the authored TypeScript
    // again when it comes up, so a customization can pass the build and still
    // bring the service down. A release is not held hostage to the user's code.
    if (!health.ok && custom === "applied" && !prepared) {
      log("the customized version does not start; rebuilding without it");
      await buildStock(build).catch(discard);
      custom = "stock";
      const broken = health.log;
      health = await prove();
      if (health.ok) notify(stockNotice("start against", broken));
    }
    if (!health.ok) {
      // A candidate this run built is garbage nothing points at. A version
      // finished earlier is somebody's way back: a failed probe never takes it.
      if (!prepared) rmSync(dir, { recursive: true, force: true });
      const staying = active ?? "the current version";
      notify(`update to ${name} did not start; staying on ${staying}`);
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

function stockNotice(verb: string, failure: string): string {
  return `your customization in data/custom does not ${verb} this version, so Iva is running the stock build:\n${failure.slice(-1500)}`;
}

type Build = {
  store: Store;
  name: string;
  dir: string;
  run: Runner;
  notify: Say;
  log: Say;
};

/** One npm step in place: its output when it failed, null when it did not. */
async function npmStep(
  dir: string,
  run: Runner,
  args: readonly string[],
): Promise<string | null> {
  const done = await run("npm", args, dir);
  return done.code === 0 ? null : done.output;
}

async function install(dir: string, run: Runner): Promise<void> {
  const failure = await npmStep(dir, run, INSTALL);
  if (failure) throw new Error(`dependency installation failed:\n${failure}`);
}

/** Build a staged version with the user's files in it, or without them if they break it. */
async function buildVersion(options: Build): Promise<Custom> {
  const { store, dir, run, notify, log } = options;
  const customDir = join(store.layout.data, "custom");
  const { files } = customOverlay(customDir);
  await install(dir, run);
  for (const path of files) {
    // Confined to the version by `isAuthoredPath`: it rejects anything absolute,
    // anything that climbs out with `..`, and everything outside `agent/`.
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(customDir, path), join(dir, path));
  }
  if (files.length > 0) log(`applied ${files.length} customized file(s)`);
  const failure = await npmStep(dir, run, BUILD);
  if (!failure) return files.length > 0 ? "applied" : "none";
  if (files.length === 0) throw new Error(`build failed:\n${failure}`);

  // The user's own code must never keep the service down: rebuild the stock tree
  // in place and say so. The customization stays untouched in data/custom.
  log("the customized build failed; rebuilding this version without it");
  await buildStock(options);
  notify(stockNotice("build against", failure));
  return "stock";
}

/**
 * Rebuild a staged version from its commit alone, dropping the overlay. It keeps
 * the name it was staged under, customization included, so a customization known
 * not to work here is tried once and not on every update.
 */
async function buildStock({ store, name, dir, run }: Build): Promise<void> {
  store.reset(name);
  await store.materialize({ sha: parseVersionName(name)?.sha ?? "", dir });
  store.linkState(dir);
  await install(dir, run);
  const failure = await npmStep(dir, run, BUILD);
  if (failure) throw new Error(`build failed:\n${failure}`);
}
