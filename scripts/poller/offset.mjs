import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseOffsetFile, serializeOffsetFile } from "../lib/offset-store.mjs";
import { OFFSET_FILE, DATA_DIR, log } from "./config.mjs";
import { tg } from "./transport.mjs";

// offset: null ⇒ no file (first run) — distinguish from a genuine offset 0.
// delivered: update_id последнего доставленного в eve апдейта (см. offset-store.mjs).
async function loadOffset({ file = OFFSET_FILE, readFileImpl = readFile } = {}) {
  try {
    return parseOffsetFile(await readFileImpl(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { offset: null, delivered: null };
    throw new Error(`failed to load Telegram offset ${file}: ${error.message}`, { cause: error });
  }
}

// First run: jump to the tail of the queue (last update_id + 1) to avoid replaying the
// install backlog. drop_pending already clears Telegram's queue — this is a belt over suspenders.
async function fastForwardOffset({ tgImpl = tg, logImpl = log } = {}) {
  try {
    const data = await tgImpl("getUpdates", { offset: -1, timeout: 0 });
    if (data?.ok !== true || !Array.isArray(data.result)) {
      throw new Error(data?.description || "invalid getUpdates response");
    }
    const list = data.result;
    // Текущий first-run контракт: пустой backlog получает числовой курсор 0,
    // который можно сразу сохранить и передать следующему getUpdates.
    if (list.length === 0) return 0;
    const updateId = list[list.length - 1]?.update_id;
    if (
      !Number.isSafeInteger(updateId) ||
      updateId < 0 ||
      updateId >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("invalid update_id in getUpdates response");
    }
    return updateId + 1;
  } catch (error) {
    logImpl("fast-forward offset failed:", error.message);
    throw new Error(`failed to fast-forward Telegram offset: ${error.message}`, {
      cause: error,
    });
  }
}

// Serialization key = eve continuation hook (telegram:<chatId>:<threadId>:):
// one chat (+ forum topic) — one session, deliver into it one at a time with a pause.
function chatKey(update) {
  const msg = update.message ?? update.callback_query?.message;
  const chatId = msg?.chat?.id;
  if (chatId === undefined) return null;
  const threadId = msg?.message_thread_id;
  return `${chatId}:${threadId ?? ""}`;
}
async function saveOffset(
  offset,
  delivered = null,
  {
    file = OFFSET_FILE,
    dataDir = DATA_DIR,
    pid = process.pid,
    tmpId = randomUUID(),
    mkdirImpl = mkdir,
    writeFileImpl = writeFile,
    renameImpl = rename,
    rmImpl = rm,
  } = {},
) {
  const tmp = `${file}.tmp-${pid}-${tmpId}`;
  try {
    await mkdirImpl(dataDir, { recursive: true });
    await writeFileImpl(tmp, serializeOffsetFile(offset, delivered), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await renameImpl(tmp, file);
  } catch (error) {
    try {
      await rmImpl(tmp, { force: true });
    } catch {
      /* исходная ошибка записи важнее ошибки уборки tmp */
    }
    throw new Error(`failed to save Telegram offset ${file}: ${error.message}`, { cause: error });
  }
}

export { loadOffset, saveOffset, fastForwardOffset, chatKey };
