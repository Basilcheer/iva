import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export const TELEGRAM_RESET_INTENT_VERSION = 1;

function intentPath(directory, chatKey) {
  return join(
    directory,
    `${Buffer.from(chatKey, "utf8").toString("base64url")}.json`,
  );
}

function normalizeIntent(value, source) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.version !== TELEGRAM_RESET_INTENT_VERSION ||
    typeof value.chatKey !== "string" ||
    !value.chatKey ||
    typeof value.continuationToken !== "string" ||
    !value.continuationToken ||
    !Number.isSafeInteger(value.requestedAt) ||
    value.requestedAt < 0
  ) {
    throw new Error(`invalid Telegram reset intent in ${source}`);
  }
  return {
    version: TELEGRAM_RESET_INTENT_VERSION,
    chatKey: value.chatKey,
    continuationToken: value.continuationToken,
    requestedAt: value.requestedAt,
  };
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureIntentDirectory(directory) {
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  await mkdir(directory, { recursive: true });
  await syncDirectory(parent);
}

export async function persistTelegramResetIntent(
  directory,
  chatKey,
  continuationToken,
  { now = Date.now, nonce = () => randomBytes(8).toString("hex") } = {},
) {
  const intent = normalizeIntent(
    {
      version: TELEGRAM_RESET_INTENT_VERSION,
      chatKey,
      continuationToken,
      requestedAt: now(),
    },
    "new reset request",
  );
  await ensureIntentDirectory(directory);
  const target = intentPath(directory, chatKey);
  const tmp = `${target}.tmp-${process.pid}-${nonce()}`;
  try {
    await writeFile(tmp, JSON.stringify(intent), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const staged = await open(tmp, "r+");
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    await rename(tmp, target);
    await syncDirectory(directory);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  return intent;
}

export async function loadTelegramResetIntents(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const intents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const intent = normalizeIntent(
      JSON.parse(await readFile(path, "utf8")),
      path,
    );
    if (intentPath(directory, intent.chatKey) !== path) {
      throw new Error(
        `Telegram reset intent filename does not match its chat key: ${path}`,
      );
    }
    intents.push(intent);
  }
  return intents.sort(
    (left, right) =>
      left.requestedAt - right.requestedAt ||
      left.chatKey.localeCompare(right.chatKey),
  );
}

export async function clearTelegramResetIntent(directory, chatKey) {
  try {
    await rm(intentPath(directory, chatKey));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await syncDirectory(directory);
}
