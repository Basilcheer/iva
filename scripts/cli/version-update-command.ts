import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRunner } from "../lib/command-runner.ts";
import { createTerminalProgress } from "../lib/progress.ts";
import {
  createTelegramUpdateReporter,
  loadTelegramJob,
  removeTelegramJob,
} from "../lib/telegram-status.ts";
import { classifyRoot, isManagedInstall } from "../lib/version-layout.ts";
import { ensureMirror, resolveTarget } from "../lib/version-mirror.ts";
import { acquireUpdateLock } from "../lib/update-lock.ts";
import { createVersionStore } from "../lib/version-store.ts";
import { runVersionUpdate, type UpdateOutcome } from "../lib/version-update.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

const COPY = {
  en: {
    fetch: ["Getting the update", "Update received"],
    build: ["Building Iva", "Iva built"],
    current: "Iva is already up to date",
    failed: "Couldn't complete the update",
    busy: "An update is already running",
    stock: "your customization in data/custom is not in this version",
  },
  ru: {
    fetch: ["Получаю обновление", "Обновление получено"],
    build: ["Собираю Iva", "Iva собрана"],
    current: "Iva уже обновлена",
    failed: "Не удалось завершить обновление",
    busy: "Обновление уже идёт",
    stock: "ваша доработка в data/custom не входит в эту версию",
  },
} as const;

/**
 * `iva update` on the immutable layout. This half only fetches and unpacks the
 * new version; from the moment its files exist the update continues inside that
 * version's own `scripts/update-finish.ts`, which is what makes an updater fix
 * arrive with the release carrying it instead of the one after it.
 */
export function createVersionUpdateCommand(
  runtime: CliRuntime,
  systemdLifecycle: { restartServices: () => void },
) {
  const install = classifyRoot(runtime.ROOT);

  async function run(args: readonly string[]): Promise<void> {
    const verbose = args.includes("--verbose");
    // `--force` is decided here and never travels: it only says that a build of
    // this release already on disk may not be reused, and what follows the
    // handoff is the ordinary install of the directory this half staged.
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
        // A version built without the overlay - reused from disk or rebuilt after
        // the user's code failed - runs stock code, and only saying so keeps them
        // from believing a skill of theirs is live.
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

  /**
   * Go back to the version that ran before this one: no git, no build, no
   * network, just one symlink and one restart.
   */
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
      // Whatever a killed probe left this version's state links pointing at,
      // activation aims them back at the installation - a way back that comes up
      // on a scratch directory that no longer exists is not a way back.
      store.activate(previous);
      systemdLifecycle.restartServices();
      // This installation is now settled on the older version; without saying so,
      // the next update would think it still owed the move it just undid.
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
