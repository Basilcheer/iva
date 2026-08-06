import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { notificationChat } from "./notification-chat.ts";
import { resolveUpdateTarget, type GitResult } from "./update-channel.ts";

export { notificationChat };

type GitCommand = (root: string, args: string[]) => Promise<GitResult | string>;
type UpdateOffer = {
  text: string;
  replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] };
};
type TelegramResponse = {
  ok: boolean;
  status: number;
  json(): Promise<{ ok?: boolean; result?: unknown; description?: string }>;
};
type TelegramFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TelegramResponse>;

function git(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: (stdout || "").trim(),
          stderr: (stderr || error?.message || "").trim(),
        });
      },
    );
  });
}

async function requireGit(gitImpl: GitCommand, root: string, args: string[]) {
  const result = await gitImpl(root, args);
  if (typeof result === "string") return result;
  if (result.code !== 0)
    throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  return result.stdout ?? "";
}

function packageVersion(jsonText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    const version =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).version
        : null;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function stableParts(version: unknown): number[] | null {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the JavaScript helper's public coercion behavior during the TypeScript conversion
  const match = String(version ?? "").match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  );
  return match ? match.slice(1).map(Number) : null;
}

export function compareStableVersions(
  localVersion: unknown,
  remoteVersion: unknown,
): number | null {
  const local = stableParts(localVersion);
  const remote = stableParts(remoteVersion);
  if (!local || !remote) return null;
  for (let i = 0; i < 3; i++) {
    if (remote[i] > local[i]) return 1;
    if (remote[i] < local[i]) return -1;
  }
  return 0;
}

export async function inspectUpstream({
  root,
  remote = "origin",
  gitImpl = git,
}: { root?: string; remote?: string; gitImpl?: GitCommand } = {}) {
  if (!root) throw new Error("update check requires a repository root");
  const run = async (...args: string[]): Promise<GitResult> => {
    const result = await gitImpl(root, args);
    return typeof result === "string"
      ? { code: 0, stdout: result, stderr: "" }
      : result;
  };
  const target = await resolveUpdateTarget({ git: run, remote });
  const local = await requireGit(gitImpl, root, ["rev-parse", "HEAD"]);
  const remoteHead = target.targetHead ?? "";
  const behind =
    Number(
      await requireGit(gitImpl, root, [
        "rev-list",
        "--count",
        `HEAD..${remoteHead}`,
      ]),
    ) || 0;
  const localVersion = packageVersion(
    await requireGit(gitImpl, root, ["show", "HEAD:package.json"]),
  );
  const remoteVersion = packageVersion(
    await requireGit(gitImpl, root, ["show", `${remoteHead}:package.json`]),
  );
  const versionComparison = compareStableVersions(localVersion, remoteVersion);
  const hasCommitUpdate = behind > 0 && local !== remoteHead;
  return {
    branch: target.branch,
    currentBranch: target.currentBranch,
    legacyMigration: target.legacyMigration,
    local,
    remote: remoteHead,
    behind,
    localVersion,
    remoteVersion,
    hasCommitUpdate,
    hasVersionUpdate: hasCommitUpdate && versionComparison === 1,
  };
}

export function updateOffer(
  localVersion: string | null | undefined,
  remoteVersion: string | null | undefined,
  locale = "en",
): UpdateOffer {
  const ru = locale === "ru";
  return {
    text: ru
      ? `⬆️ Доступна новая версия Iva\n\nv${localVersion} → v${remoteVersion}\nНастройки и локальные изменения будут сохранены.`
      : `⬆️ A new Iva version is available\n\nv${localVersion} → v${remoteVersion}\nSettings and local changes will be preserved.`,
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: ru ? "⬆️ Обновить" : "⬆️ Update",
            callback_data: "iva_update:do",
          },
          { text: ru ? "Позже" : "Later", callback_data: "iva_update:skip" },
        ],
      ],
    },
  };
}

export async function sendUpdateOffer({
  token,
  chatId,
  offer,
  fetchImpl = fetch,
}: {
  token?: string;
  chatId?: string | number;
  offer?: UpdateOffer;
  fetchImpl?: TelegramFetch;
} = {}): Promise<unknown> {
  if (!offer) throw new Error("update offer is required");
  const response = await fetchImpl(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: offer.text,
        reply_markup: offer.replyMarkup,
      }),
    },
  );
  const data: { ok?: boolean; result?: unknown; description?: string } =
    await response
      .json()
      .catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
  if (!response.ok || !data.ok)
    throw new Error(data.description || `Telegram ${response.status}`);
  return data.result;
}

export function updateCheckStatePath(dataDir: string): string {
  return join(dataDir, "update-check.json");
}

export async function readNotifiedVersion(
  dataDir: string,
): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(updateCheckStatePath(dataDir), "utf8"),
    );
    const state =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    return typeof state?.lastNotifiedVersion === "string"
      ? state.lastNotifiedVersion
      : null;
  } catch {
    return null;
  }
}

export async function markVersionNotified(
  dataDir: string,
  version: string,
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = updateCheckStatePath(dataDir);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      temp,
      `${JSON.stringify({ lastNotifiedVersion: version, notifiedAt: new Date().toISOString() })}\n`,
      {
        mode: 0o600,
      },
    );
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}
