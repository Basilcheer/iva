import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { readEnvFresh } from "../lib/env-file.ts";
import {
  inspectUpstream,
  markVersionNotified,
  updateOffer,
} from "../lib/update-check.ts";
import { modelSummary } from "../lib/model-summary.ts";
import { reporterFor } from "../lib/telegram-status.ts";
import { classifyRoot, upstreamQuery } from "../lib/version-layout.ts";
import { createVersionStore, updateRunning } from "../lib/version-store.ts";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import { getLang, tr } from "#lib/i18n.ts";
import {
  ALLOWED,
  DATA_DIR,
  ENV_PATH,
  NODE,
  ROOT,
  UPDATE_JOB_TTL_MS,
  log,
  sleep,
} from "./config.ts";
import { edit, reply, tg } from "./transport.ts";

type UpdateInfo = Awaited<ReturnType<typeof inspectUpstream>>;
type UpdateCheckOptions = {
  /** The tree this bridge runs out of; on the immutable layout, `<home>/current`. */
  root?: string;
  inspectImpl?: (options: {
    root: string;
    head?: string;
  }) => Promise<UpdateInfo>;
  markNotifiedImpl?: (dataDir: string, version: string) => Promise<void>;
  envImpl?: () => Promise<NodeJS.ProcessEnv>;
};
type TelegramMessage = { message_id: number };
type UpdateCallbackQuery = {
  id: string;
  from?: { id?: string | number };
  message?: { chat?: { id?: string | number }; message_id?: number };
  data: string;
};
type LaunchResult = { ok: boolean; msg: string };
type ErrorLike = { message?: unknown };
type RecoveryReport = {
  schema: "iva-update-conflicts/v1";
  conflicts: { path: string }[];
};

// ── self-update (/update) ──────────────────────────────────────────────────
// Run `iva update` in its OWN transient systemd scope, so it survives the restart of
// THIS bridge (restartServices restarts iva-telegram-poll too — a plain child would be
// killed with us). --collect GC's the unit after exit. The updater reads a 0600 job
// file and posts each phase directly through Bot API, so no bridge process survives.
function launchSelfUpdate(jobId: string): Promise<LaunchResult> {
  const args = [
    "--user",
    "--collect",
    `--unit=iva-self-update-${Date.now()}`,
    `--working-directory=${ROOT}`,
    `--setenv=PATH=${process.env.PATH || ""}`,
    NODE,
    join(ROOT, "bin/iva.mjs"),
    "update",
    "--telegram-job",
    jobId,
  ];
  return new Promise<LaunchResult>((resolve) =>
    execFile("systemd-run", args, (err, out, e) =>
      resolve({ ok: !err, msg: (e || out || "").toString().trim() }),
    ),
  );
}

export async function handleUpdateCheck(
  chatId: string | number,
  {
    root = ROOT,
    inspectImpl = inspectUpstream,
    markNotifiedImpl = markVersionNotified,
    envImpl = () => readEnvFresh(ENV_PATH),
  }: UpdateCheckOptions = {},
): Promise<void> {
  const status = (await reply(
    chatId,
    tr("◇ Checking for updates", "◇ Проверяю обновления"),
  )) as TelegramMessage | null;
  if (!status) return;
  let info;
  try {
    // The same question the daily check asks, and on a converted installation the
    // same two answers: a version has no `.git` of its own, and the mirror's HEAD
    // is upstream's, so the running commit has to be named.
    info = await inspectImpl(upstreamQuery(root));
  } catch {
    await edit(
      chatId,
      status.message_id,
      tr("⚠️ Couldn't check for updates", "⚠️ Не удалось проверить обновления"),
    );
    return;
  }
  if (!info.hasCommitUpdate) {
    // Not modelSummary(process.env): the /model wizard edits .env at runtime and restarts
    // only the agent — this bridge keeps running, so its env snapshot may hold the old model.
    const model = modelSummary(await envImpl());
    await edit(
      chatId,
      status.message_id,
      tr(
        `✅ You're up to date\n\nIva v${info.localVersion ?? "?"}\nModel: ${model.line}`,
        `✅ У вас актуальная версия\n\nIva v${info.localVersion ?? "?"}\nМодель: ${model.line}`,
      ),
    );
    return;
  }
  const bump =
    info.remoteVersion && info.remoteVersion !== info.localVersion
      ? `v${info.localVersion ?? "?"} → v${info.remoteVersion}`
      : tr(
          `v${info.localVersion ?? "?"} → newer build`,
          `v${info.localVersion ?? "?"} → новая сборка`,
        );
  const offered = await edit(
    chatId,
    status.message_id,
    tr(
      `⬆️ Update available\n\n${bump}\nSettings and local changes will be preserved.`,
      `⬆️ Доступно обновление\n\n${bump}\nНастройки и локальные изменения будут сохранены.`,
    ),
    updateOffer(info.localVersion, info.remoteVersion, getLang()).replyMarkup,
  );
  if (offered && info.hasVersionUpdate) {
    await markNotifiedImpl(DATA_DIR, info.remoteVersion).catch(
      (error: unknown) =>
        log("update notification state failed:", (error as ErrorLike).message),
    );
  }
}

const jobsDir = (): string => join(DATA_DIR, "update-jobs");

async function removeStaleUpdateJobs(): Promise<void> {
  const jobs = jobsDir();
  let names;
  try {
    names = await readdir(jobs);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const path = join(jobs, name);
        try {
          if (Date.now() - (await stat(path)).mtimeMs > UPDATE_JOB_TTL_MS)
            await rm(path, { force: true });
        } catch {
          // Stale-job cleanup tolerates files disappearing or changing concurrently.
        }
      }),
  );
}

async function showSavedUpdateConflicts(
  bundleId: string,
  chatId: string | number,
  messageId: number,
): Promise<void> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(bundleId) ||
    bundleId === "." ||
    bundleId === ".."
  ) {
    await edit(
      chatId,
      messageId,
      tr("⚠️ Invalid recovery bundle", "⚠️ Неверный пакет восстановления"),
    );
    return;
  }
  let report: RecoveryReport;
  try {
    const parsed: unknown = JSON.parse(
      await readFile(
        join(DATA_DIR, "update-conflicts", bundleId, "report.json"),
        "utf8",
      ),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { schema?: unknown }).schema !== "iva-update-conflicts/v1" ||
      !Array.isArray((parsed as { conflicts?: unknown }).conflicts)
    )
      throw new Error("invalid recovery report");
    const conflicts = (parsed as { conflicts: unknown[] }).conflicts;
    if (
      conflicts.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          typeof (item as { path?: unknown }).path !== "string",
      )
    )
      throw new Error("invalid conflict list");
    report = parsed as RecoveryReport;
  } catch {
    await edit(
      chatId,
      messageId,
      tr(
        "⚠️ Saved update details are unavailable",
        "⚠️ Детали обновления недоступны",
      ),
    );
    return;
  }
  const visible = report.conflicts.slice(0, 10).map(({ path }) => `- ${path}`);
  if (report.conflicts.length > visible.length) {
    const remaining = report.conflicts.length - visible.length;
    visible.push(
      tr(`- ${remaining} more conflict(s)`, `- Ещё конфликтов: ${remaining}`),
    );
  }
  const details =
    visible.length > 0
      ? tr(
          `Saved local conflicts:\n${visible.join("\n")}`,
          `Сохранённые локальные конфликты:\n${visible.join("\n")}`,
        )
      : tr(
          "Your local changes are saved in full.",
          "Ваши локальные изменения сохранены целиком.",
        );
  await edit(
    chatId,
    messageId,
    [
      tr("✅ The new Iva core is active.", "✅ Новое ядро Iva активно."),
      "",
      details,
      "",
      tr(
        "Tell Iva: “restore my update changes”.",
        "Напишите Иве: «восстанови мои изменения после обновления».",
      ),
    ].join("\n"),
    { inline_keyboard: [] },
  );
}

// Inline-button taps for the /update flow. Handled by the bridge; never delivered to eve.
export async function handleUpdateCallback(
  cq: UpdateCallbackQuery,
): Promise<true> {
  const from = String(cq.from?.id ?? "");
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  await tg("answerCallbackQuery", { callback_query_id: cq.id }); // clear the button spinner
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return true; // swallow untrusted taps
  const action = cq.data.slice("iva_update:".length);
  if (action === "skip") {
    await edit(
      chatId as string | number,
      messageId as number,
      tr("– Update postponed", "– Обновление отложено"),
      { inline_keyboard: [] },
    );
    return true;
  }
  if (action.startsWith("conflicts:")) {
    await showSavedUpdateConflicts(
      action.slice("conflicts:".length),
      chatId as string | number,
      messageId as number,
    );
    return true;
  }

  const jobId = randomBytes(8).toString("hex");
  // Asked, never taken: the updater this launches owns the lock from end to end.
  // A lock claimed here on its behalf would outlive the launch - this bridge does
  // not release it, and it is restarted by the very update it is waiting for - so
  // one tap would answer "already running" to every update after it.
  if (updateRunning(DATA_DIR)) {
    await edit(
      chatId as string | number,
      messageId as number,
      tr("⚠️ An update is already running", "⚠️ Обновление уже идёт"),
      { inline_keyboard: [] },
    );
    return true;
  }
  // The version that runs as the tap is made. What the update moves the box off
  // of, written down while the process that knows it is still alive: after the
  // restart nothing else can name it. A development checkout has no version and
  // simply leaves the field out.
  const currentAtStart = createVersionStore(
    classifyRoot(ROOT).home,
  ).currentName();
  await writeFileAtomic(
    join(jobsDir(), `${jobId}.json`),
    JSON.stringify({
      chatId,
      messageId,
      locale: getLang(),
      startedAt: new Date().toISOString(),
      ...(currentAtStart ? { currentAtStart } : {}),
    }),
    { mode: 0o600 },
  );
  await edit(
    chatId as string | number,
    messageId as number,
    tr("◇ Saving your changes", "◇ Сохраняю ваши изменения"),
    { inline_keyboard: [] },
  );
  const r = await launchSelfUpdate(jobId);
  if (!r.ok) {
    await rm(join(jobsDir(), `${jobId}.json`), { force: true });
    await edit(
      chatId as string | number,
      messageId as number,
      tr("⚠️ Couldn't start the update", "⚠️ Не удалось запустить обновление"),
    );
  }
  return true;
}

// ── the last word on an update (reconciliation) ────────────────────────────
// The updater that installs a version dies with the restart it orders: its process
// is the retired version's. Whatever it still owed the chat it leaves in the job
// file, and this bridge - the process the restart brings up - is what says it.

/** How often a job with no outcome yet is looked at again. */
const WATCH_TICK_MS = 5_000;
/** How long after the lock goes a job is given to grow an outcome. */
const WATCH_GRACE_MS = 30_000;

type UpdateJob = {
  chatId?: string | number;
  messageId?: string | number;
  locale?: string;
  startedAt?: string;
  /** The version that ran when the tap was made; absent on a checkout. */
  currentAtStart?: string;
  outcome?: unknown;
};
type FinalVersions = { beforeVersion?: string; afterVersion: string };
type ReconcileOptions = {
  root?: string;
  tickMs?: number;
  graceMs?: number;
};
type VersionStore = ReturnType<typeof createVersionStore>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readUpdateJob(path: string): Promise<UpdateJob | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null; // Gone, or never valid JSON: there is nothing to answer with.
  }
}

/** The final an updater wrote down, or null when it never got that far. */
function outcomeOf(job: UpdateJob): FinalVersions | null {
  const outcome = job.outcome;
  if (!isRecord(outcome)) return null;
  if (outcome.schema !== "iva-update-outcome/v1") return null;
  if (outcome.status !== "updated") return null;
  const { after, before } = outcome;
  if (typeof after !== "string" || !after) return null;
  return {
    afterVersion: after,
    beforeVersion: typeof before === "string" && before ? before : undefined,
  };
}

/**
 * The same final screen the updater would have shown, through the same reporter:
 * one vocabulary, one Gate, one set of retries. False keeps the job for the next
 * start of the bridge, with the six-hour TTL as the ceiling.
 */
async function deliverFinal(
  job: UpdateJob,
  versions: FinalVersions,
): Promise<boolean> {
  let reporter;
  try {
    const env = await readEnvFresh(ENV_PATH);
    reporter = reporterFor(job, env.TELEGRAM_BOT_TOKEN, env);
    if (!reporter) return false; // No chat, no message: nothing to answer.
    return await reporter.complete(versions);
  } catch (error) {
    log("update final delivery failed:", (error as ErrorLike).message);
    return false;
  } finally {
    reporter?.dispose();
  }
}

/** The version that runs now, when it is not the one the tap was made on. */
function flippedTo(store: VersionStore, job: UpdateJob): string | null {
  if (typeof job.currentAtStart !== "string") return null;
  const current = store.currentName();
  return current && current !== job.currentAtStart ? current : null;
}

function finishedAfterStart(
  startedAt: string | undefined,
  settledAt: string | null,
): boolean {
  const started = Date.parse(startedAt ?? "");
  const settled = Date.parse(settledAt ?? "");
  return (
    Number.isFinite(started) && Number.isFinite(settled) && settled > started
  );
}

/**
 * A move that did not stick. A rollback settles the installation back onto the
 * version it started on (version-update.ts: recordLive(name, false), activate(back),
 * settle(back)), so the settle marker of a failed update is as fresh as a good one's
 * and says nothing about which way it went. Neither does the age of the directories:
 * activate() relinks state inside the version it turns on, so the build a rollback
 * lands back on is the freshest thing on disk and the running one at the same time.
 * What the rollback does leave is the build it came off - present, not running, and
 * on record as having taken the service down. That is the whole reading.
 *
 * Why any such build and not only a recent one: this is asked on one branch only -
 * a job too old to name the version it started on - and such a job comes from a
 * bridge that the update itself replaces, so it is answered once and then never
 * exists again; the six-hour TTL is its ceiling either way. A failure left on disk
 * by an older update therefore costs at most one spinner that expires, while a
 * rollback read as a success costs a "✅" on the version the update just failed to
 * leave. The conservative reading is the cheap one.
 */
function rolledBack(store: VersionStore, running: string): boolean {
  return store
    .list()
    .some((name) => name !== running && store.liveFailed(name));
}

/**
 * A job whose updater never got to write its outcome down - killed between the
 * flip and the file. The installation itself is the only witness left, and a "✅"
 * invented without one is worse than the spinner it would replace: a job nothing
 * proves is left to the TTL rather than answered with a guess.
 */
async function concludeUpdateJob(
  path: string,
  job: UpdateJob,
  store: VersionStore,
  moved: string | null,
): Promise<void> {
  if (moved) {
    // An update is a move that finished onto a version that lives, off a version
    // that lived. Three questions, and a "✅" needs all three answered.
    //
    // Did the move finish? The settle marker is the last thing an update writes,
    // and it is written after the service has answered on its port (version-update.ts:
    // recordLive(name, true), then settle(name)). Everything between the flip and it -
    // the migrations, the vault cleanup, the restart, the health deadline - is where
    // an updater dies without leaving a verdict on anything: `current` is the new
    // build, no failure is on record, and the flip alone reads "✅ old → new" over an
    // agent that may be lying down. `settled() === moved` is what the installation
    // itself says about that, and the same marker `iva doctor` reads to report an
    // "update to X never finished". It also survives what the failure list does not:
    // that list keeps only the last few builds, so a verdict can be pushed out of it,
    // and a guard that only asks about failures goes blind exactly then.
    //
    // Is the version it stands on good? The marker alone does not say so. A rollback
    // settles the version it goes back to without ever proving it (version-update.ts:
    // activate(back), then settle(back), with no probe between), so the far end of a
    // rollback satisfies `settled() === moved` too - only the verdict on that version
    // rules out a "✅ old → new" over a box that does not answer.
    //
    // Is the version it came off good? A job written while the box already sat on a
    // half-installed build names that build as its start. The resumed run rolls back
    // off it - recordLive(new, false), activate(old), settle(old) - which moves
    // `current` to the old version and settles there, so `settled() === moved` holds
    // once more and the arrow drawn from it reads "✅ new → old": a downgrade sold as
    // an update. The verdict the rollback recorded on the version this job started on
    // is what catches that one.
    //
    // Neither verdict is read off the failures lying around on disk: rolledBack()
    // below asks whether anything not running ever took the service down, and after
    // an honest update the previous update's corpse is still there - that reading
    // would swallow a ✅ the user is owed. A job that named its version asks about
    // its own two ends and nothing else.
    const dead =
      store.liveFailed(moved) ||
      (typeof job.currentAtStart === "string" &&
        store.liveFailed(job.currentAtStart));
    if (dead || store.settled() !== moved) {
      log(
        dead
          ? "update job left for the ttl; an end of the move is on record as dead:"
          : "update job left for the ttl; the move onto this version never settled:",
        basename(path),
      );
      return;
    }
    if (
      await deliverFinal(job, {
        beforeVersion: job.currentAtStart,
        afterVersion: moved,
      })
    )
      await rm(path, { force: true });
    return;
  }
  // A job from a bridge that did not write down the version it started on. The
  // settle marker is all there is, and it can only say that a move finished -
  // so the user is told which version runs, without an arrow nobody can draw.
  // A move that finished by going back is still a finished move, and the marker
  // reads the same either way: a rollback has to be ruled out here, or the box
  // reports "✅ updated" on the version the update just failed to leave.
  const after = store.currentName() ?? store.settled();
  if (
    job.currentAtStart === undefined &&
    after &&
    !rolledBack(store, after) &&
    finishedAfterStart(job.startedAt, store.settledAt())
  ) {
    if (await deliverFinal(job, { afterVersion: after }))
      await rm(path, { force: true });
    return;
  }
  log(
    "update job left for the ttl; nothing proves the update finished:",
    basename(path),
  );
}

/**
 * One job with no outcome, watched until the installation says something about
 * it. Runs beside the polling loop: every tick is guarded, and a tick that throws
 * is a line in the journal, never a bridge that stopped answering messages.
 */
async function watchUpdateJob(
  path: string,
  snapshot: UpdateJob,
  { root, tickMs, graceMs }: Required<ReconcileOptions>,
): Promise<void> {
  const store = createVersionStore(classifyRoot(root).home);
  const deadline = Date.now() + UPDATE_JOB_TTL_MS;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    await sleep(tickMs);
    try {
      // The updater still holds the lock: it is alive and owes the chat nothing.
      if (updateRunning(DATA_DIR)) {
        quietSince = null;
        continue;
      }
      const job = await readUpdateJob(path);
      const outcome = job && outcomeOf(job);
      if (job && outcome) {
        if (await deliverFinal(job, outcome)) await rm(path, { force: true });
        return;
      }
      const moved = flippedTo(store, snapshot);
      // The file went with an updater that answered the chat itself: nothing was
      // installed, so nothing restarted, so the report went out the ordinary way.
      if (!job && !moved) return;
      quietSince ??= Date.now();
      if (Date.now() - quietSince < graceMs) continue;
      await concludeUpdateJob(path, job ?? snapshot, store, moved);
      return;
    } catch (error) {
      log("update job watch failed:", (error as ErrorLike).message);
    }
  }
  log("update job watch gave up on:", basename(path));
}

/**
 * Answer every update the box has not answered yet. Called once at start, after
 * the stale-job sweep and before the first poll: a job with an outcome is a final
 * screen owed right now, and a job without one is watched in the background while
 * messages keep flowing. The watchers it returns are the caller's to await; the
 * bridge only counts them.
 */
export async function reconcileUpdateJobs({
  root = ROOT,
  tickMs = WATCH_TICK_MS,
  graceMs = WATCH_GRACE_MS,
}: ReconcileOptions = {}): Promise<Promise<void>[]> {
  let names: string[];
  try {
    names = await readdir(jobsDir());
  } catch {
    return []; // No update was ever asked for on this box.
  }
  const watchers: Promise<void>[] = [];
  for (const name of names.filter((one) => one.endsWith(".json"))) {
    const path = join(jobsDir(), name);
    // One job's bad luck stays its own, exactly as in the stale sweep above. This
    // runs before deleteWebhook: a throw here is the bridge exiting into a systemd
    // restart, onto the same unreadable - or undeletable - file, forever. A chat
    // that never gets its final screen must not cost the box every other message.
    try {
      const job = await readUpdateJob(path);
      if (!job) continue;
      const outcome = outcomeOf(job);
      if (!outcome) {
        watchers.push(watchUpdateJob(path, job, { root, tickMs, graceMs }));
        continue;
      }
      if (await deliverFinal(job, outcome)) await rm(path, { force: true });
      else log("update final undelivered; the job waits for the next start");
    } catch (error) {
      log("update job reconcile failed:", name, (error as ErrorLike).message);
    }
  }
  return watchers;
}

export { removeStaleUpdateJobs };
