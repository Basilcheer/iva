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
  createTelegramUpdateReporter,
  loadTelegramJob,
  removeTelegramJob,
} from "../lib/telegram-status.ts";
import { resolveUpdateTarget } from "../lib/update-channel.ts";
import {
  gitAt,
  packageVersion,
  requireGit,
  type GitCommand,
} from "../lib/update-check.ts";
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

/** A bare mirror, cloned from the checkout: nothing runs from it, so it is free to rewrite. */
export async function ensureMirror({
  home,
  checkout,
  git = gitAt,
}: {
  home: string;
  checkout: string;
  git?: GitCommand;
}): Promise<string> {
  const repo = join(home, "repo");
  if (existsSync(repo)) return repo;
  const staging = `${repo}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    const source = join(checkout, ".git");
    await requireGit(git, home, ["clone", "--mirror", source, staging]);
    const origin = await requireGit(git, checkout, [
      "remote",
      "get-url",
      "origin",
    ]);
    await requireGit(git, staging, ["remote", "set-url", "origin", origin]);
    const key = "iva.updateBranch";
    const branch = await git(checkout, ["config", "--local", "--get", key]);
    const value = typeof branch === "string" ? branch : (branch.stdout ?? "");
    if (value.trim())
      await requireGit(git, staging, ["config", key, value.trim()]);
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
export async function resolveTarget({
  repo,
  git = gitAt,
}: {
  repo: string;
  git?: GitCommand;
}): Promise<{ sha: string; version: string }> {
  let sha: string | undefined;
  try {
    const target = await resolveUpdateTarget({
      git: (...args) => {
        const result = git(repo, args);
        return Promise.resolve(result).then((value) =>
          typeof value === "string" ? { code: 0, stdout: value } : value,
        );
      },
    });
    sha = target.targetHead;
  } catch {
    // Offline, or a remote that refuses the fetch.
  }
  if (!sha) sha = await requireGit(git, repo, ["rev-parse", "HEAD"]);
  const version = packageVersion(
    await requireGit(git, repo, ["show", `${sha}:package.json`]),
  );
  if (!version) throw new Error(`no package version at ${sha}`);
  return { sha, version };
}

/**
 * `iva update` on the immutable layout. This half only fetches and unpacks the new
 * version; from there the update continues inside that version's own
 * `scripts/update-finish.ts`, so an updater fix arrives with the release
 * carrying it instead of the one after it.
 */
export function createVersionUpdateCommand(
  runtime: CliRuntime,
  systemdLifecycle: { restartServices: () => void },
) {
  const install = classifyRoot(runtime.ROOT);

  async function run(args: readonly string[]): Promise<void> {
    const verbose = args.includes("--verbose");
    // `--force` is decided here and never travels: it only says a build of this
    // release already on disk may not be reused.
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
      ? createTelegramUpdateReporter({
          // The reporter is the runtime boundary that validates a persisted job.
          job: job.job as NonNullable<
            Parameters<typeof createTelegramUpdateReporter>[0]
          >["job"],
          token: env.TELEGRAM_BOT_TOKEN,
          env,
        })
      : null;
    const store = createVersionStore(install.home);
    // The last version the installation actually settled on: after an interrupted
    // update `current` already names the new one, which would report as "X → X".
    const before =
      store.settled() ?? store.currentName() ?? "the previous version";
    const reportDir = mkdtempSync(join(tmpdir(), "iva-update-"));
    const report = join(reportDir, "outcome.json");
    const failed = async (detail: string): Promise<void> => {
      terminal.fail(text.failed);
      terminal.info(detail);
      await reporter?.fail("build", before);
      process.exitCode = 1;
    };

    try {
      terminal.start(text.fetch[0]);
      await reporter?.start("fetch");
      const repo = await ensureMirror({
        home: install.home,
        checkout: install.home,
      });
      const outcome = await runVersionUpdate({
        home: install.home,
        store,
        resolveTarget: () => resolveTarget({ repo }),
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
        process.exitCode = 1;
      } else if (outcome.status === "unhealthy") await failed(outcome.log);
      else if (outcome.status === "failed") await failed(outcome.message);
      else if (outcome.status === "current") {
        terminal.done(text.fetch[1]);
        terminal.info(`✅ ${text.current} (${outcome.version})`);
        await reporter?.complete({
          beforeVersion: outcome.version,
          afterVersion: outcome.version,
        });
      } else {
        terminal.done(text.build[1]);
        terminal.info(`✅ ${outcome.previous ?? before} → ${outcome.version}`);
        // A version built without the overlay runs stock code; saying so is what
        // keeps the user from believing a skill of theirs is live.
        if (outcome.custom === "stock") terminal.info(`⚠️ ${text.stock}`);
        await reporter?.complete({
          beforeVersion: outcome.previous ?? before,
          afterVersion: outcome.version,
        });
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
      // Activation aims this version's state links back at the installation: a way
      // back that comes up on a deleted scratch directory is not a way back.
      store.activate(previous);
      systemdLifecycle.restartServices();
      // Settled on the older version; without saying so, the next update would
      // think it still owed the move it just undid.
      store.settle(previous);
      runtime.ok(`${from ?? "the broken version"} → ${previous}`);
      // Nothing here pins a version, and the release this went back from is still
      // what upstream resolves to.
      runtime.warn("the next `iva update` can bring that version back");
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
