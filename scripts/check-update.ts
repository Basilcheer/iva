import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/entrypoint.ts";
import { classifyRoot, gitRootFor } from "./lib/version-layout.ts";
import { createVersionStore, parseVersionName } from "./lib/version-store.ts";
import { acquireUpdateLock } from "./lib/update-lock.ts";
import {
  inspectUpstream,
  markVersionNotified,
  notificationChat,
  readNotifiedVersion,
  sendUpdateOffer,
  updateOffer,
} from "./lib/update-check.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type UpdateEnvironment = Record<string, string | undefined>;
type UpdateInfo = Awaited<ReturnType<typeof inspectUpstream>>;
type SendUpdateRequest = {
  token: string;
  chatId: string;
  offer: ReturnType<typeof updateOffer>;
};
type DailyUpdateOptions = {
  root?: string;
  env?: UpdateEnvironment;
  inspectImpl?: (options: {
    root: string;
    head?: string;
  }) => Promise<UpdateInfo>;
  sendImpl?: (request: SendUpdateRequest) => Promise<unknown>;
  readStateImpl?: typeof readNotifiedVersion;
  writeStateImpl?: typeof markVersionNotified;
};

function dataDir(root: string, env: UpdateEnvironment): string {
  const configured = env.ASSISTANT_DATA_DIR || "data";
  return configured.startsWith("/") ? configured : join(root, configured);
}

export async function runDailyUpdateCheck({
  root = ROOT,
  env = process.env,
  inspectImpl = inspectUpstream,
  sendImpl = sendUpdateOffer,
  readStateImpl = readNotifiedVersion,
  writeStateImpl = markVersionNotified,
}: DailyUpdateOptions = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = notificationChat(env);
  if (!token || !chatId) return { status: "not-configured" as const };

  const storage = dataDir(root, env);
  // The same lock the updater itself takes, with the same rules about when a
  // holder counts as gone: two answers to that question on one file is how a
  // crashed update ends up blocking the daily check for hours.
  const lock = acquireUpdateLock(storage);
  if (!lock) return { status: "update-running" as const };
  try {
    // On the immutable layout nothing runs from a working tree: upstream is read from
    // the mirror, and "what is installed" is the commit the active version was built from.
    const install = classifyRoot(root);
    const active = createVersionStore(install.home).currentName();
    const info = await inspectImpl({
      root: gitRootFor(install),
      head: (active && parseVersionName(active)?.sha) || "HEAD",
    });
    if (!info.hasVersionUpdate) return { status: "current" as const, info };
    if ((await readStateImpl(storage)) === info.remoteVersion) {
      return { status: "already-notified" as const, info };
    }

    const offer = updateOffer(
      info.localVersion,
      info.remoteVersion,
      env.AGENT_LANGUAGE === "ru" ? "ru" : "en",
    );
    await sendImpl({ token, chatId, offer });
    await writeStateImpl(storage, info.remoteVersion);
    return { status: "notified" as const, info };
  } finally {
    lock.release();
  }
}

export async function main(entryUrl = import.meta.url): Promise<void> {
  if (!isEntrypoint(entryUrl)) return;
  try {
    const result = await runDailyUpdateCheck();
    if (result.status === "notified") {
      console.log(`Update notification sent: v${result.info.remoteVersion}`);
    }
  } catch (error) {
    // Preserve the former JavaScript entrypoint's unchecked property access and
    // template coercion exactly; this boundary must not normalize thrown values.
    console.error(
      `Update check failed: ${(error as { message: string }).message}`,
    );
    process.exitCode = 1;
  }
}
