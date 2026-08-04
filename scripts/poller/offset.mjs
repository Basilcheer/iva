import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseOffsetFile, serializeOffsetFile } from "../lib/offset-store.mjs";
import { OFFSET_FILE, DATA_DIR, log } from "./config.mjs";
import { tg } from "./transport.mjs";

// offset: null ⇒ no file (first run) — distinguish from a genuine offset 0.
// delivered: update_id последнего доставленного в eve апдейта (см. offset-store.mjs).
async function loadOffset() {
  try {
    return parseOffsetFile(await readFile(OFFSET_FILE, "utf8"));
  } catch {
    return { offset: null, delivered: null };
  }
}

// First run: jump to the tail of the queue (last update_id + 1) to avoid replaying the
// install backlog. drop_pending already clears Telegram's queue — this is a belt over suspenders.
async function fastForwardOffset() {
  try {
    const data = await tg("getUpdates", { offset: -1, timeout: 0 });
    const list = data.ok ? data.result || [] : [];
    return list.length ? list[list.length - 1].update_id + 1 : 0;
  } catch (e) {
    log("fast-forward offset failed:", e.message);
    return 0;
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
async function saveOffset(offset, delivered = null) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(OFFSET_FILE, serializeOffsetFile(offset, delivered), "utf8");
  } catch (e) {
    log("offset save failed:", e.message);
  }
}

export { loadOffset, saveOffset, fastForwardOffset, chatKey };
