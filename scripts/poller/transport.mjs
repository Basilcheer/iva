import { execFile } from "node:child_process";
import { API, TOKEN, log } from "./config.mjs";

// Every Bot API call carries a deadline — a hung response must never stall the single polling loop.
// The default suits normal calls; getUpdates overrides it to sit above its own long-poll window.
async function tg(method, body, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

// Read a web ReadableStream as UTF-8 text with a HARD cap: it stops and cancels the stream the moment
// the running total exceeds maxBytes, so an oversized (or size-unknown) body is never fully buffered.
// The caller passes an already time-bounded body (see downloadTelegramFile) so a hung socket mid-read
// aborts the read too. Returns null on over-size or a read error. Pure — unit-tested off the network.
export async function readCappedStream(body, maxBytes) {
  if (!body || typeof body.getReader !== "function") return null;
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Download a Telegram file's bytes as UTF-8 text (getFile → file download), hard-capped at maxBytes and
// deadline-bounded at every step (getFile call, the download connection, and the streamed read — a size
// cap alone doesn't save the loop from a stalled socket). Returns null on any failure or over-size.
async function downloadTelegramFile(fileId, maxBytes) {
  try {
    const info = await tg("getFile", { file_id: fileId }, { timeoutMs: 10_000 });
    const filePath = info?.result?.file_path;
    if (!filePath) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    // Cheap early reject when the server declares an over-size body; the stream reader below is the
    // hard cap regardless (a missing or lying Content-Length can't get past it).
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    return await readCappedStream(res.body, maxBytes);
  } catch {
    return null;
  }
}
async function reply(chatId, text) {
  try {
    const data = await tg("sendMessage", { chat_id: chatId, text });
    if (!data.ok) throw new Error(data.description || "sendMessage failed");
    return data.result;
  } catch (e) {
    log("reply failed:", e.message);
    return null;
  }
}

async function edit(chatId, messageId, text, replyMarkup) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
    const data = await tg("editMessageText", body);
    if (!data.ok) throw new Error(data.description || "editMessageText failed");
    return data.result;
  } catch (e) {
    if (!/message is not modified/i.test(e.message)) log("edit failed:", e.message);
    return null;
  }
}

const sc = (...args) =>
  new Promise((resolve) => execFile("systemctl", ["--user", ...args], (err) => resolve(!err)));

export { tg, downloadTelegramFile, reply, edit, sc };
