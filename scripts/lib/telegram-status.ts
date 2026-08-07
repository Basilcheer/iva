import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { modelSummary } from "./model-summary.ts";
import type { RestoreReport } from "./update-safety.ts";

type UpdatePhase = "protect" | "fetch" | "build";
type TelegramJob = {
  chatId: string | number;
  messageId: string | number;
  locale?: string;
};
type TelegramData = {
  ok?: boolean;
  result?: unknown;
  description?: string;
  parameters?: { retry_after?: number };
};
type TelegramResponse = {
  ok: boolean;
  status: number;
  json(): Promise<TelegramData>;
};
type TelegramFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TelegramResponse>;
type TelegramError = Error & { status?: number };
type Reporter = {
  start(phase: UpdatePhase): Promise<void>;
  done(phase: UpdatePhase): Promise<void>;
  fail(phase: UpdatePhase, beforeVersion: string): Promise<void>;
  postCommitFailure(message: string): Promise<void>;
  complete(versions: {
    beforeVersion: string;
    afterVersion: string;
    changedLocal?: boolean;
    restoreReport?: RestoreReport;
  }): Promise<void>;
  dispose(): void;
};

// Animated triangle loader from https://t.me/addemoji/iconemoji1.
// Bots whose owner doesn't have Telegram Premium transparently fall back to ◇.
export const UPDATE_LOADER = {
  alt: "🔺",
  customEmojiId: "5980787993139481991",
  fallback: "◇",
};

const COPY = {
  en: {
    protect: [
      "Saving your changes",
      "Changes saved",
      "Couldn't save your changes",
    ],
    fetch: ["Getting the update", "Update received", "Couldn't get the update"],
    build: ["Building Iva", "Iva built", "Couldn't build Iva"],
    timerFailure:
      "Iva is ready, but the automatic update timer could not be activated",
    final: "✅ Iva updated",
    preserved: "Local changes: preserved",
    conflicted: (count: number) =>
      `⚠️ ${count} local file(s) conflicted with the update. The new core is active; your versions are stored safely.`,
    preservedInactive:
      "⚠️ Local customizations did not build. The new core is active; your changes are stored safely.",
    review: "Review saved changes",
    failure: (version: string) =>
      `Iva is still running ${version}.\nYour settings and changes are preserved.\nRetry: /update`,
  },
  ru: {
    protect: [
      "Сохраняю ваши изменения",
      "Изменения сохранены",
      "Не удалось сохранить изменения",
    ],
    fetch: [
      "Получаю обновление",
      "Обновление получено",
      "Не удалось получить обновление",
    ],
    build: ["Собираю Iva", "Iva собрана", "Не удалось собрать Iva"],
    timerFailure:
      "Iva готова, но таймер автоматических обновлений не удалось активировать",
    final: "✅ Iva обновлена",
    preserved: "Локальные изменения: сохранены",
    conflicted: (count: number) =>
      `⚠️ Конфликт локальных файлов: ${count}. Новое ядро активно; ваши версии надёжно сохранены.`,
    preservedInactive:
      "⚠️ Локальные доработки не собрались. Новое ядро активно; ваши изменения надёжно сохранены.",
    review: "Посмотреть сохранённые изменения",
    failure: (version: string) =>
      `Iva продолжает работать на ${version}.\nВаши настройки и изменения сохранены.\nПовторить: /update`,
  },
};

export function createTelegramUpdateReporter({
  token,
  job,
  env,
  fetchImpl = fetch,
  sleepImpl,
}: {
  token?: string;
  job?: TelegramJob;
  env?: Record<string, string | undefined>;
  fetchImpl?: TelegramFetch;
  sleepImpl?: (ms: number) => Promise<void>;
} = {}): Reporter | null {
  if (!token || !job?.chatId || !job?.messageId) return null;
  const lang = job.locale === "ru" ? "ru" : "en";
  const copy = COPY[lang];
  const api = `https://api.telegram.org/bot${token}`;
  const activeJob = job;
  let currentMessageId: string | number | null = activeJob.messageId;
  let currentPhase: UpdatePhase | null = null;
  let lastPayload = "";
  let uiLost = false;
  let customEmojiSupported = true;
  const wait =
    sleepImpl ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${api}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await wait(250 * attempt);
        continue;
      }
      const data: TelegramData = await res.json().catch((): TelegramData => ({
        ok: false,
        description: `HTTP ${res.status}`,
      }));
      if (res.ok && data.ok) return data.result;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === 3) {
        const error: TelegramError = new Error(
          data.description || `Telegram ${res.status}`,
        );
        error.status = res.status;
        throw error;
      }
      const retryMs = Math.min(
        5000,
        Math.max(250, Number(data.parameters?.retry_after || 1) * 1000),
      );
      await wait(retryMs);
    }
    throw new Error("Telegram request failed");
  }

  async function edit(
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: TelegramError }> {
    if (!currentMessageId) return { ok: false };
    const payload = JSON.stringify(body);
    if (payload === lastPayload) return { ok: true };
    try {
      await call("editMessageText", {
        chat_id: activeJob.chatId,
        message_id: currentMessageId,
        ...body,
      });
      lastPayload = payload;
      return { ok: true };
    } catch (caught) {
      const error = caught as TelegramError;
      if (/message is not modified/i.test(error.message)) {
        lastPayload = payload;
        return { ok: true };
      }
      if (
        /message to edit not found|message can't be edited/i.test(error.message)
      ) {
        currentMessageId = null;
        uiLost = true;
      }
      return { ok: false, error };
    }
  }

  async function editActive(text: string): Promise<void> {
    if (customEmojiSupported) {
      const rich = {
        text: `${UPDATE_LOADER.alt} ${text}`,
        entities: [
          {
            type: "custom_emoji",
            offset: 0,
            length: UPDATE_LOADER.alt.length,
            custom_emoji_id: UPDATE_LOADER.customEmojiId,
          },
        ],
      };
      const result = await edit(rich);
      if (result.ok) return;
      if (!currentMessageId) return;
      if (result.error?.status !== 400) return;
      customEmojiSupported = false;
    }
    await edit({ text: `${UPDATE_LOADER.fallback} ${text}` });
  }

  async function finish(
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<void> {
    const body = replyMarkup ? { text, reply_markup: replyMarkup } : { text };
    if ((await edit(body)).ok) return;
    if (!uiLost) return;
    try {
      await call("sendMessage", { chat_id: activeJob.chatId, ...body });
    } catch {
      // The final status notification is best-effort after the original UI is lost.
    }
  }

  return {
    async start(phase: UpdatePhase) {
      currentPhase = phase;
      if (!uiLost) await editActive(copy[phase][0]);
    },
    done(phase: UpdatePhase) {
      // The next phase replaces this one in the same message. A transient
      // "done" edit would only add API traffic and flicker without preserving history.
      if (currentPhase !== phase) return Promise.resolve();
      currentPhase = null;
      return Promise.resolve();
    },
    async fail(phase: UpdatePhase, beforeVersion: string) {
      const reason = copy[phase][2];
      currentPhase = null;
      await finish(`⚠️ ${reason}\n\n${copy.failure(beforeVersion)}`);
    },
    async postCommitFailure(message: string) {
      currentPhase = null;
      await finish(`⚠️ ${copy.timerFailure}\n\n${message}`);
    },
    async complete({
      beforeVersion,
      afterVersion,
      restoreReport,
    }: {
      beforeVersion: string;
      afterVersion: string;
      restoreReport?: RestoreReport;
    }) {
      const model = modelSummary(env);
      const lines = [
        copy.final,
        "",
        `${beforeVersion} → ${afterVersion}`,
        `${lang === "ru" ? "Модель" : "Model"}: ${model.line}`,
      ];
      lines.push(copy.preserved);
      let replyMarkup: Record<string, unknown> | undefined;
      if (
        restoreReport?.status === "conflicted" ||
        restoreReport?.status === "preserved"
      ) {
        lines.push(
          "",
          restoreReport.status === "conflicted"
            ? copy.conflicted(restoreReport.conflicts.length)
            : copy.preservedInactive,
        );
        const bundleId = basename(restoreReport.recoveryDir);
        const callbackData = `iva_update:conflicts:${bundleId}`;
        if (Buffer.byteLength(callbackData, "utf8") <= 64)
          replyMarkup = {
            inline_keyboard: [
              [{ text: copy.review, callback_data: callbackData }],
            ],
          };
      }
      await finish(lines.join("\n"), replyMarkup);
    },
    dispose() {},
  };
}

export async function loadTelegramJob(
  dataDir: string,
  jobId: string | undefined,
): Promise<{ path: string; job: unknown } | null> {
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) return null;
  const path = join(dataDir, "update-jobs", `${jobId}.json`);
  try {
    return { path, job: JSON.parse(await readFile(path, "utf8")) };
  } catch {
    return null;
  }
}

export async function removeTelegramJob(
  path: string | undefined,
): Promise<void> {
  if (path) await rm(path, { force: true }).catch(() => {});
}
