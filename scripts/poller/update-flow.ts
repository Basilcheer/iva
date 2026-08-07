import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { readEnvFresh } from "../lib/env-file.ts";
import {
  inspectUpstream,
  markVersionNotified,
  updateOffer,
} from "../lib/update-check.ts";
import { modelSummary } from "../lib/model-summary.ts";
import { acquireUpdateLock, releaseUpdateLock } from "../lib/update-safety.ts";
import { getLang, tr } from "#lib/i18n.ts";
import {
  ALLOWED,
  DATA_DIR,
  ENV_PATH,
  NODE,
  ROOT,
  UPDATE_JOB_TTL_MS,
  log,
} from "./config.ts";
import { edit, reply, tg } from "./transport.ts";

type UpdateInfo = Awaited<ReturnType<typeof inspectUpstream>>;
type UpdateCheckOptions = {
  inspectImpl?: (options: { root: string }) => Promise<UpdateInfo>;
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
    info = await inspectImpl({ root: ROOT });
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

async function removeStaleUpdateJobs(): Promise<void> {
  const jobs = join(DATA_DIR, "update-jobs");
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
  const lock = acquireUpdateLock(DATA_DIR, jobId);
  if (!lock.ok) {
    await edit(
      chatId as string | number,
      messageId as number,
      tr("⚠️ An update is already running", "⚠️ Обновление уже идёт"),
      { inline_keyboard: [] },
    );
    return true;
  }
  const jobs = join(DATA_DIR, "update-jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(
    join(jobs, `${jobId}.json`),
    JSON.stringify({
      chatId,
      messageId,
      locale: getLang(),
      startedAt: new Date().toISOString(),
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
    releaseUpdateLock(lock);
    await rm(join(jobs, `${jobId}.json`), { force: true });
    await edit(
      chatId as string | number,
      messageId as number,
      tr("⚠️ Couldn't start the update", "⚠️ Не удалось запустить обновление"),
    );
  }
  return true;
}

export { removeStaleUpdateJobs };
