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
import {
  classifyRoot,
  isManagedInstall,
  type Install,
} from "../lib/version-layout.ts";
import { ensureMirror, resolveTarget } from "../lib/version-mirror.ts";
import { acquireUpdateLock } from "../lib/update-lock.ts";
import { createVersionStore } from "../lib/version-store.ts";
import { runVersionUpdate, type UpdateOutcome } from "../lib/version-update.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

type UpdateCopy = {
  readonly fetch: readonly [string, string];
  readonly build: readonly [string, string];
  readonly current: string;
  readonly failed: string;
  readonly busy: string;
};

const COPY: Record<"en" | "ru", UpdateCopy> = {
  en: {
    fetch: ["Getting the update", "Update received"],
    build: ["Building Iva", "Iva built"],
    current: "Iva is already up to date",
    failed: "Couldn't complete the update",
    busy: "An update is already running",
  },
  ru: {
    fetch: ["Получаю обновление", "Обновление получено"],
    build: ["Собираю Iva", "Iva собрана"],
    current: "Iva уже обновлена",
    failed: "Не удалось завершить обновление",
    busy: "Обновление уже идёт",
  },
};

/**
 * `iva update` on the immutable layout.
 *
 * This half only fetches and unpacks the new version; the moment its files exist,
 * the update continues inside the new version's own `scripts/update-finish.ts`.
 * That is what makes an updater fix arrive with the release that carries it
 * instead of the one after it.
 */
export function createVersionUpdateCommand(
  runtime: CliRuntime,
  systemdLifecycle: { restartServices: () => void },
) {
  const install: Install = classifyRoot(runtime.ROOT);

  async function run(args: readonly string[]): Promise<void> {
    const verbose = args.includes("--verbose");
    // `--force` reaches the new version's updater too: what it repairs - the
    // dependencies and the build output of a version that already exists - only
    // exists on the other side of the handoff.
    const force = args.includes("--force");
    const telegramJobAt = args.indexOf("--telegram-job");
    const jobId = telegramJobAt >= 0 ? (args[telegramJobAt + 1] ?? "") : "";
    const env = runtime.readEnv();
    const locale =
      (env.AGENT_LANGUAGE || process.env.AGENT_LANGUAGE) === "ru" ? "ru" : "en";
    const text = COPY[locale];
    const terminal = createTerminalProgress({ verbose });
    const job = await loadTelegramJob(runtime.dataDirAbs(env), jobId);
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
          // The progress spinner and the new version's own output must not share a line.
          terminal.dispose();
          return Promise.resolve(handoff(name, report, { verbose, force }));
        },
      });
      await finishReport({ outcome, terminal, reporter, text, before });
    } catch (error) {
      terminal.fail(text.failed);
      terminal.info((error as { message?: string }).message ?? String(error));
      await reporter?.fail("build", before);
      process.exitCode = 1;
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
    flags: { verbose: boolean; force: boolean },
  ): UpdateOutcome {
    const dir = join(install.home, "versions", name);
    const result = spawnSync(
      process.execPath,
      [
        join(dir, "scripts/update-finish.ts"),
        install.home,
        name,
        ...(flags.verbose ? ["--verbose"] : []),
        ...(flags.force ? ["--force"] : []),
      ],
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
      throw new Error(
        `the new version's updater exited with code ${result.status ?? "unknown"}`,
      );
    }
  }

  /**
   * Go back to the version that ran before this one. No git, no build, no
   * network: the previous version is still on disk, so this is one symlink and
   * one restart.
   */
  function rollback(): void {
    const store = createVersionStore(install.home);
    const previous = store.previousName();
    if (!previous) {
      runtime.bad("no previous version to go back to");
      process.exitCode = 1;
      return;
    }
    const lock = acquireUpdateLock(store.layout.data);
    if (!lock) {
      runtime.bad("an update is already running");
      process.exitCode = 1;
      return;
    }
    try {
      const from = store.currentName();
      store.activate(previous);
      systemdLifecycle.restartServices();
      // This installation is now settled on the older version; without saying so,
      // the next update would think it still owed the move it just undid.
      store.settle(previous);
      runtime.ok(`${from ?? "the broken version"} → ${previous}`);
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

async function finishReport({
  outcome,
  terminal,
  reporter,
  text,
  before,
}: {
  outcome: UpdateOutcome;
  terminal: ReturnType<typeof createTerminalProgress>;
  reporter: ReturnType<typeof createTelegramUpdateReporter> | null;
  text: UpdateCopy;
  before: string;
}): Promise<void> {
  if (outcome.status === "busy") {
    terminal.fail(text.busy);
    process.exitCode = 1;
    return;
  }
  if (outcome.status === "current") {
    terminal.done(text.fetch[1]);
    terminal.info(`✅ ${text.current} (${outcome.version})`);
    await reporter?.complete({
      beforeVersion: outcome.version,
      afterVersion: outcome.version,
    });
    return;
  }
  if (outcome.status === "unhealthy" || outcome.status === "failed") {
    terminal.fail(text.failed);
    terminal.info(
      outcome.status === "unhealthy" ? outcome.log : outcome.message,
    );
    await reporter?.fail("build", before);
    process.exitCode = 1;
    return;
  }
  terminal.done(text.build[1]);
  terminal.info(`✅ ${outcome.previous ?? before} → ${outcome.version}`);
  await reporter?.complete({
    beforeVersion: outcome.previous ?? before,
    afterVersion: outcome.version,
  });
}
