import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalProgress } from "../lib/progress.ts";
import {
  loadTelegramJob,
  removeTelegramJob,
  reporterFor,
} from "../lib/telegram-status.ts";
import { resolveUpdateTarget } from "../lib/update-channel.ts";
import { gitAt, packageVersion, requireGit } from "../lib/update-check.ts";
import { classifyRoot, isManagedInstall } from "../lib/version-layout.ts";
import { acquireUpdateLock, createVersionStore } from "../lib/version-store.ts";
import {
  commandRunner,
  runVersionUpdate,
  type UpdateOutcome,
} from "../lib/version-update.ts";
import type { createCliRuntime } from "./runtime.ts";
import { COPY } from "./update.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

/** A bare mirror of the checkout: nothing runs from it, so it is free to rewrite. */
export async function ensureMirror(home: string): Promise<string> {
  const repo = join(home, "repo");
  if (existsSync(repo)) return repo;
  const staging = `${repo}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  const git = (root: string, args: string[]): Promise<string> =>
    requireGit(gitAt, root, args);
  const key = "iva.updateBranch"; // What the installation follows, not the clone.
  try {
    await git(home, ["clone", "--mirror", join(home, ".git"), staging]);
    const origin = await git(home, ["remote", "get-url", "origin"]);
    await git(staging, ["remote", "set-url", "origin", origin]);
    const branch = (await gitAt(home, ["config", "--local", "--get", key]))
      .stdout;
    if (branch) await git(staging, ["config", key, branch]);
    renameSync(staging, repo);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return repo;
}

/**
 * What the next version is built from. An unreachable remote is not a failure: the
 * newest mirrored commit is the honest answer, so an offline update is a no-op.
 */
export async function resolveTarget(
  repo: string,
): Promise<{ sha: string; version: string }> {
  let sha = "";
  try {
    const target = await resolveUpdateTarget({
      git: (...args) => gitAt(repo, args),
    });
    sha = target.targetHead ?? "";
  } catch {
    // Offline, or a remote that refuses the fetch.
  }
  if (!sha) sha = await requireGit(gitAt, repo, ["rev-parse", "HEAD"]);
  const version = packageVersion(
    await requireGit(gitAt, repo, ["show", `${sha}:package.json`]),
  );
  if (!version) throw new Error(`no package version at ${sha}`);
  return { sha, version };
}

/** The release the running tree is, straight from its own package.json. */
function installedVersion(root: string): string | null {
  try {
    return packageVersion(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null; // No readable package.json: nothing to name it with.
  }
}

/**
 * `iva update` on the immutable layout. This half only fetches and unpacks the new
 * version; it continues inside that version's own `scripts/update-finish.ts`, so
 * an updater fix arrives with the release carrying it and not the one after.
 */
export function createVersionUpdateCommand(
  runtime: CliRuntime,
  systemdLifecycle: { restartServices: () => void },
) {
  const install = classifyRoot(runtime.ROOT);

  async function run(args: readonly string[]): Promise<void> {
    const verbose = args.includes("--verbose");
    // Decided here and never travelling: a build of this release already on disk
    // may not be reused.
    const force = args.includes("--force");
    const jobAt = args.indexOf("--telegram-job");
    const env = runtime.readEnv();
    const language = env.AGENT_LANGUAGE || process.env.AGENT_LANGUAGE;
    const text = COPY[language === "ru" ? "ru" : "en"];
    const terminal = createTerminalProgress({ verbose });
    const job = await loadTelegramJob(
      runtime.dataDirAbs(env),
      jobAt >= 0 ? (args[jobAt + 1] ?? "") : "",
    );
    const reporter = job
      ? reporterFor(job.job, env.TELEGRAM_BOT_TOKEN, env)
      : null;
    const store = createVersionStore(install.home);
    // The last version the installation actually settled on: after an interrupted
    // update `current` already names the new one, which would report as "X → X".
    // On the first conversion there is no version yet, and the checkout being
    // retired knows its own release - the user is told a number, not a pronoun.
    const before =
      store.settled() ??
      store.currentName() ??
      installedVersion(install.root) ??
      "the previous version";
    const reportDir = mkdtempSync(join(tmpdir(), "iva-update-"));
    const report = join(reportDir, "outcome.json");
    const finished = (from: string, to: string): Promise<void> =>
      reporter?.complete({ beforeVersion: from, afterVersion: to }) ??
      Promise.resolve();
    const failed = async (detail: string): Promise<void> => {
      terminal.fail(text.failed);
      terminal.info(detail);
      await reporter?.fail("build", before);
      process.exitCode = 1;
    };

    try {
      terminal.start(text.fetch[0]);
      await reporter?.start("fetch");
      const repo = await ensureMirror(install.home);
      const outcome = await runVersionUpdate({
        home: install.home,
        store,
        resolveTarget: () => resolveTarget(repo),
        run: commandRunner(verbose),
        force,
        log: (message) => terminal.info(message),
        handoff: (name) => {
          terminal.done(text.fetch[1]);
          void reporter?.done("fetch");
          terminal.start(text.build[0]);
          void reporter?.start("build");
          // The spinner and the new version's own output must not share a line.
          terminal.dispose();
          return Promise.resolve(handoff(name, report, verbose));
        },
      });

      if (outcome.status === "busy") {
        terminal.fail(text.busy);
        // Or the Telegram message stays on the phase it never got past.
        await reporter?.busy();
        process.exitCode = 1;
      } else if (outcome.status === "unhealthy") await failed(outcome.log);
      else if (outcome.status === "failed") await failed(outcome.message);
      else if (outcome.status === "current") {
        terminal.done(text.fetch[1]);
        terminal.info(`✅ ${text.current} (${outcome.version})`);
        await finished(outcome.version, outcome.version);
      } else {
        terminal.done(text.build[1]);
        terminal.info(`✅ ${outcome.previous ?? before} → ${outcome.version}`);
        // Or the user goes on believing a skill of theirs is live.
        if (outcome.custom === "stock") terminal.info(`⚠️ ${text.stock}`);
        await finished(outcome.previous ?? before, outcome.version);
      }
    } catch (error) {
      await failed((error as { message?: string }).message ?? String(error));
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
      terminal.dispose();
      reporter?.dispose();
      await removeTelegramJob(job?.path);
    }
  }

  /** Run the new version's updater, in its own process, from its own directory. */
  function handoff(
    name: string,
    report: string,
    verbose: boolean,
  ): UpdateOutcome {
    const dir = join(install.home, "versions", name);
    const args = [join(dir, "scripts/update-finish.ts"), install.home, name];
    const result = spawnSync(
      process.execPath,
      verbose ? [...args, "--verbose"] : args,
      {
        cwd: dir,
        stdio: "inherit",
        env: { ...runtime.childEnv, IVA_UPDATE_OUTCOME: report },
      },
    );
    if (result.error) throw result.error;
    try {
      return JSON.parse(readFileSync(report, "utf8")) as UpdateOutcome;
    } catch {
      const code = result.status ?? "unknown";
      throw new Error(`the new version's updater exited with code ${code}`);
    }
  }

  /** Back to the version that ran before: no git, no build, no network. */
  function rollback(): void {
    const store = createVersionStore(install.home);
    const previous = store.previousName();
    const lock = previous ? acquireUpdateLock(store.layout.data) : null;
    if (!previous || !lock) {
      runtime.bad(
        previous
          ? "an update is already running"
          : "no previous version to go back to",
      );
      process.exitCode = 1;
      return;
    }
    try {
      const from = store.currentName();
      // Activation aims this version's state back at the installation: a way back
      // that comes up on a deleted scratch directory is not a way back.
      store.activate(previous);
      systemdLifecycle.restartServices();
      // Or the next update believes it still owes the move this just undid.
      store.settle(previous);
      runtime.ok(`${from ?? "the broken version"} → ${previous}`);
      // Nothing pins a version: upstream still resolves to the one left behind,
      // and with two builds on disk another rollback is a way back onto it too.
      runtime.warn(
        "another `iva rollback`, like the next `iva update`, can bring that version back",
      );
    } finally {
      lock.release();
    }
  }

  return {
    /** Only a real installation is converted; a development checkout is left alone. */
    active: (): boolean => isManagedInstall(install),
    run,
    rollback,
  };
}
