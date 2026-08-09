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
import { createVersionStore } from "../lib/version-store.ts";
import { runVersionUpdate, type UpdateOutcome } from "../lib/version-update.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

type UpdateCopy = {
  readonly fetch: readonly [string, string];
  readonly build: readonly [string, string];
  readonly current: string;
  readonly failed: string;
  readonly forced: string;
  readonly busy: string;
};

const COPY: Record<"en" | "ru", UpdateCopy> = {
  en: {
    fetch: ["Getting the update", "Update received"],
    build: ["Building Iva", "Iva built"],
    current: "Iva is already up to date",
    failed: "Couldn't complete the update",
    forced: "--force is ignored: a version is rebuilt only for a new commit",
    busy: "An update is already running",
  },
  ru: {
    fetch: ["Получаю обновление", "Обновление получено"],
    build: ["Собираю Iva", "Iva собрана"],
    current: "Iva уже обновлена",
    failed: "Не удалось завершить обновление",
    forced: "--force игнорируется: версия пересобирается только под новый коммит",
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
export function createVersionUpdateCommand(runtime: CliRuntime) {
  const install: Install = classifyRoot(runtime.ROOT);

  async function run(args: readonly string[]): Promise<void> {
    const verbose = args.includes("--verbose");
    const telegramJobAt = args.indexOf("--telegram-job");
    const jobId = telegramJobAt >= 0 ? (args[telegramJobAt + 1] ?? "") : "";
    const env = runtime.readEnv();
    const locale = (env.AGENT_LANGUAGE || process.env.AGENT_LANGUAGE) === "ru" ? "ru" : "en";
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
    const before = store.currentName() ?? "the previous version";
    const reportDir = mkdtempSync(join(tmpdir(), "iva-update-"));
    const report = join(reportDir, "outcome.json");

    if (args.includes("--force")) terminal.info(text.forced);
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
        log: (message) => terminal.info(message),
        handoff: (name) => {
          terminal.done(text.fetch[1]);
          void reporter?.done("fetch");
          terminal.start(text.build[0]);
          void reporter?.start("build");
          // The progress spinner and the new version's own output must not share a line.
          terminal.dispose();
          return Promise.resolve(handoff(name, report, verbose));
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
  function handoff(name: string, report: string, verbose: boolean): UpdateOutcome {
    const dir = join(install.home, "versions", name);
    const result = spawnSync(
      process.execPath,
      [
        join(dir, "scripts/update-finish.ts"),
        install.home,
        name,
        ...(verbose ? ["--verbose"] : []),
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

  return {
    /** Only a real installation is converted; a development checkout is left alone. */
    active: (): boolean => isManagedInstall(install),
    run,
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
  if (outcome.status === "unhealthy") {
    terminal.fail(text.failed);
    terminal.info(outcome.log);
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
