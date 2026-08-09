import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isAuthoredPath } from "./authored-paths.ts";
import { probeEnvironment, probeVersion } from "./health-probe.ts";
import {
  bindProbe,
  DEFAULT_PORT,
  PortChecker,
  PortSelector,
  procProbe,
} from "./ports.ts";
import {
  acquireUpdateLock,
  createVersionStore,
  parseVersionName,
  readJson,
  releaseOf,
  versionName,
  writeJson,
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
const MIGRATION_FILE = /^\d{3}-[a-z0-9-]+\.ts$/;
const MIGRATION_MARKER = "migrations.json";
const OUTPUT_TAIL = 20_000;

export type MigrationContext = Record<string, unknown>;
export type Migration = (context: MigrationContext) => void | Promise<void>;

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
  /** Hands the staged version to the updater that version ships. */
  readonly handoff?: (name: string) => Promise<UpdateOutcome>;
};

/** The files the user authored; the rest of `data/custom` is the layer's bookkeeping. */
function authored(customDir: string): string[] {
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

/** The authored files and a digest of them: an edit to `data/custom` is a version. */
export function customOverlay(customDir: string): {
  files: string[];
  digest: string | null;
} {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const path of authored(customDir)) {
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
  return {
    files,
    digest: files.length > 0 ? hash.digest("hex").slice(0, 8) : null,
  };
}

function sameFile(one: string, other: string): boolean {
  try {
    return readFileSync(one).equals(readFileSync(other));
  } catch {
    return false;
  }
}

/**
 * What a version on disk was built with, by contents and not by names: a stock tree
 * has files at authored paths too, `agent/instructions.md` above all.
 */
export function builtWith(
  dir: string,
  name: string,
  customDir: string,
): Custom {
  if (!parseVersionName(name)?.overlay) return "none";
  const { files } = customOverlay(customDir);
  return files.length > 0 &&
    files.every((path) => sameFile(join(dir, path), join(customDir, path)))
    ? "applied"
    : "stock";
}

/**
 * A port to start the version on: the pid spreads two updaters apart, the selector
 * steps over what is listening. Not the docker probe - it shells out per port, and
 * a published port is a listening socket to the other two anyway.
 */
function probePort(): Promise<number | null> {
  return new PortSelector(new PortChecker([bindProbe, procProbe])).firstFree(
    DEFAULT_PORT + 100 + (process.pid % 100),
  );
}

/**
 * One update: build a new immutable version, prove it starts, flip a symlink, then
 * move the installation onto it. Nothing before the flip touches the running
 * version, and nothing after it is a one-shot - the next run replays it.
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
    // Half of what gets built, so half of what the version is called: edited
    // mid-update, the digest simply differs again on the next run.
    const { digest } = customOverlay(join(store.layout.data, "custom"));
    const release = versionName(target.version, target.sha, digest);
    const active = store.currentName();
    // Finished, not just flipped: unrun migrations are an update still owed.
    const settled =
      active && releaseOf(active) === release && store.settled() === active;
    if (settled && !force) {
      store.gc(KEEP);
      return { status: "current", version: active };
    }

    // Reusing a finished build makes dropping a customization a flip, not a build.
    // `--force` refuses it: the build already there is the broken one.
    const finished = force
      ? undefined
      : store.list().find((name) => releaseOf(name) === release);
    const name = finished ?? store.nextBuild(release);
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
    // A handoff leaves the child owning this lock; release only drops one's own.
    lock.release();
  }
}

/**
 * The half of an update the new version runs about itself - install, build, prove,
 * flip, migrate, restart - so the code just fetched runs it instead of the code
 * being replaced. The flip decides what runs, the marker whether the move is done.
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
  const customDir = join(store.layout.data, "custom");
  const active = store.currentName();
  const env = store.layout.env;
  const check: Probe =
    probe ??
    ((at, port) =>
      probeVersion({ dir: at, port, env: probeEnvironment(env, port, at) }));
  let custom = builtWith(dir, name, customDir);
  /** A version being built is garbage nothing points at: a failure takes it away. */
  const discard = (error: unknown): never => {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  };
  const prove = async (): Promise<Health> => {
    // A real server start, on scratch state: an update about to be thrown away
    // must not have touched the installation.
    const scratch = store.sandboxState(name);
    try {
      const port = await probePort();
      if (port === null) return { ok: false, log: "no free port for a probe" };
      return await check(dir, port);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  // Built by a run that never activated it: the tree is there, the rest is owed.
  const prepared = store.list().includes(name);
  if (active === name) {
    // The flip happened, the rest did not: pick the update up where it stopped.
    log(`finishing the move onto ${name}`);
  } else {
    if (prepared) log(`reusing prepared version ${name}`);
    else
      custom = await buildVersion(store, name, run, notify, log).catch(discard);
    let health = await prove();
    // A green build is not a start: the service compiles the authored TypeScript
    // again when it comes up, and a release is not the user's code to hold up.
    if (!health.ok && custom === "applied" && !prepared) {
      log("the customized version does not start; rebuilding without it");
      await buildStock(store, name, run).catch(discard);
      custom = "stock";
      const broken = health.log;
      health = await prove();
      if (health.ok) notify(stockNotice("start against", broken));
    }
    if (!health.ok) {
      // Garbage nothing points at - unless an earlier run finished it, in which
      // case it is somebody's way back and a failed probe never takes it.
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

  // Before the restart: the service must not open state still to be migrated.
  const migrations = await runMigrations({
    dir: join(dir, "scripts/migrations"),
    dataDir: store.layout.data,
    context: { home, dataDir: store.layout.data, versionDir: dir },
    log,
  });
  await restart(store.layout.current);
  // After it: until the service runs the new version, the old checkout is what a
  // failed restart falls back to, so it is not ours to remove any earlier.
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

/** One npm step in place; the step's own output is the failure report. */
async function npmStep(
  dir: string,
  run: Runner,
  args: readonly string[],
  what: string,
): Promise<void> {
  const done = await run("npm", args, dir);
  if (done.code !== 0) throw new Error(`${what} failed:\n${done.output}`);
}

/** Build a staged version with the user's files in it, or without them if they break it. */
async function buildVersion(
  store: Store,
  name: string,
  run: Runner,
  notify: Say,
  log: Say,
): Promise<Custom> {
  const dir = join(store.layout.versions, name);
  const customDir = join(store.layout.data, "custom");
  const { files } = customOverlay(customDir);
  await npmStep(dir, run, INSTALL, "dependency installation");
  for (const path of files) {
    // Confined to the version by `isAuthoredPath`: it rejects anything absolute,
    // anything that climbs out with `..`, and everything outside `agent/`.
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(customDir, path), join(dir, path));
  }
  if (files.length > 0) log(`applied ${files.length} customized file(s)`);
  const built = await run("npm", BUILD, dir);
  if (built.code === 0) return files.length > 0 ? "applied" : "none";
  if (files.length === 0) throw new Error(`build failed:\n${built.output}`);

  // The user's own code must never keep the service down: rebuild the stock tree
  // in place and say so. The customization stays untouched in data/custom.
  log("the customized build failed; rebuilding this version without it");
  await buildStock(store, name, run);
  notify(stockNotice("build against", built.output));
  return "stock";
}

/**
 * Rebuild a staged version from its commit alone, under the name it was staged
 * with, digest and all: a customization known not to work here is tried once.
 */
async function buildStock(
  store: Store,
  name: string,
  run: Runner,
): Promise<void> {
  const dir = store.reset(name);
  await store.materialize({ sha: parseVersionName(name)?.sha ?? "", dir });
  store.linkState(dir);
  await npmStep(dir, run, INSTALL, "dependency installation");
  await npmStep(dir, run, BUILD, "build");
}

/** Names already applied. An unreadable marker means "nothing", never a crash. */
function appliedMigrations(dataDir: string): string[] {
  const applied = readJson(join(dataDir, MIGRATION_MARKER)).applied;
  return Array.isArray(applied)
    ? applied.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * The migrations this version ships and has not applied. The marker only avoids
 * repeat work - each migration is idempotent, so losing it stays recoverable.
 */
export async function runMigrations({
  dir,
  dataDir,
  context,
  log,
}: {
  readonly dir: string;
  readonly dataDir: string;
  readonly context: MigrationContext;
  readonly log?: Say;
}): Promise<string[]> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => MIGRATION_FILE.test(name));
  } catch {
    return [];
  }
  const applied = appliedMigrations(dataDir);
  const done: string[] = [];
  const marker = join(dataDir, MIGRATION_MARKER);
  for (const name of files.sort().map((file) => file.slice(0, -3))) {
    if (applied.includes(name)) continue;
    log?.(`migration ${name}`);
    try {
      const module = (await import(
        pathToFileURL(join(dir, `${name}.ts`)).href
      )) as { default: Migration };
      await module.default(context);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${name} failed: ${detail}`, { cause: error });
    }
    done.push(name);
    writeJson(marker, {
      schema: "iva-migrations/v1",
      applied: [...applied, ...done],
    });
  }
  return done;
}

/** npm as a `Runner`: silent unless it fails, when its output is the report. */
export function commandRunner(verbose: boolean): Runner {
  return (command, args, cwd) =>
    new Promise<CommandResult>((resolve) => {
      const io = verbose ? "inherit" : "pipe";
      const child = spawn(command, [...args], {
        cwd,
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", io, io],
      });
      let output = "";
      const collect = (chunk: unknown): void => {
        output = `${output}${String(chunk)}`.slice(-OUTPUT_TAIL);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => resolve({ code: 1, output: error.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
}
