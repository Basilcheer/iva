import { createMenu } from "../lib/menu/index.mjs";
import { botCommands, helpText, tr } from "../lib/i18n.mjs";
import { continuationTokenForControl } from "../lib/telegram-reset.mjs";
import { getChatStatus, isRunning } from "../lib/run-status.mjs";
import { readEnvFresh } from "../lib/env-file.mjs";
import { ALLOWED, DATA_DIR, ENV_PATH, ROOT, log } from "./config.mjs";
import { downloadTelegramFile, edit, reply, sc, tg } from "./transport.mjs";
import { chatKey } from "./offset.mjs";
import { deliver } from "./deliver.mjs";
import { performScopedReset } from "./queue.mjs";
import { deliverDirectUpdate } from "./routing.mjs";
import { handleUpdateCallback, handleUpdateCheck } from "./update-flow.mjs";
import {
  endWizard,
  flows,
  getWizard,
  handleKeyMessage,
  handleModelCmd,
  handleThinkCmd,
  handleWizardCallback,
  resetMessageCopy,
} from "./wizards.mjs";

// Движок /menu: делит session-store (flows) с визардами /model//think. deps — мост отдаёт
// экранам всё нужное (пути, systemctl, доставку в eve, allowlist, хендофф в визарды).
const menu = createMenu({
  flows,
  tg,
  deps: {
    envPath: ENV_PATH,
    dataDir: DATA_DIR,
    root: ROOT,
    sc,
    reply,
    // Синтетическая дистилляция делит acceptance, пейсинг и уборку failed-ingress
    // с обычной прямой доставкой, но намеренно не проходит busy-time FIFO.
    deliver: (update) => deliverDirectUpdate(update).then((result) => result === "delivered"),
    log,
    allowed: ALLOWED,
    handleModelCmd,
    handleThinkCmd,
    handleUpdateCheck,
  },
});

// setMyCommands: синее командное меню Telegram из общей таблицы COMMANDS (default=en +
// language_code:"ru"). Идемпотентно, зовётся на каждом старте моста; ошибки нефатальны.
async function registerBotCommands() {
  try {
    await tg("setMyCommands", { commands: botCommands("en") });
    await tg("setMyCommands", { commands: botCommands("ru"), language_code: "ru" });
  } catch (e) {
    log("setMyCommands failed:", e.message);
  }
}

// Delete a message carrying a secret, warning the user if Telegram won't let us — a rejected secret
// must never silently linger in the chat (mirrors the delete-first path in menu.onText).
async function deleteSecretMessage(chatId, messageId) {
  const del = await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => ({ ok: false }));
  if (!del?.ok) {
    await reply(chatId, tr("Couldn't delete your message — please delete it manually.", "Не смог удалить сообщение — удали его вручную.")).catch(() => {});
  }
  return del?.ok === true;
}

// Default I/O for handleAwaitNonText — injectable so the delete→download ordering and the
// "never reaches eve" contract can be unit-tested with mocks.
const nonTextIo = {
  deleteSecret: (chatId, id) => deleteSecretMessage(chatId, id),
  reply: (chatId, text) => reply(chatId, text),
  download: (fileId, max) => downloadTelegramFile(fileId, max),
  // Run the screen's own text handler on downloaded content WITHOUT re-deleting (already deleted).
  deliver: (text, msg, st) => menu.onText({ ...msg, text }, st, { skipDelete: true }),
};

// A non-text message arrived while a menu/wizard awaits a SECRET (the caller gates this to
// secret/file-capable states — a non-secret interview attachment falls through to eve untouched).
// It must never reach eve. For a file-capable prompt (gws client_secret) a document is captured;
// crucially the message is DELETED FIRST, before the download, so the secret doesn't linger in the
// chat for the download's duration. Anything else is deleted with a clear ack telling the user how
// to send it. Always returns true (the update is consumed, not delivered).
export async function handleAwaitNonText(msg, pending, io = nonTextIo) {
  const chatId = msg.chat?.id;
  const a = pending.awaitText;
  const MAX_BYTES = 256 * 1024;
  if (a?.file && msg.document && pending.flow === "menu") {
    if ((msg.document.file_size ?? 0) > MAX_BYTES) {
      await io.deleteSecret(chatId, msg.message_id);
      await io.reply(chatId, tr("That file is too large — paste the contents as text instead.", "Файл слишком большой — вставь содержимое текстом."));
      return true;
    }
    // Delete FIRST, and only proceed once the secret has actually left the chat. If Telegram
    // refused the deletion, deleteSecret already told the user to remove it manually — we must NOT
    // download or deliver a secret that is still visible in the conversation. Consume it either way
    // so it never reaches eve.
    const deleted = await io.deleteSecret(chatId, msg.message_id);
    if (!deleted) return true;
    const content = await io.download(msg.document.file_id, MAX_BYTES);
    if (content == null) {
      await io.reply(chatId, tr("Couldn't read that file — paste the contents as text instead.", "Не смог прочитать файл — вставь содержимое текстом."));
      return true;
    }
    await io.deliver(content, msg, pending); // skipDelete is safe now — the message is confirmed gone
    return true;
  }
  // Secret prompt, but not a capturable file (a photo, or a text-only secret) — delete it so it can't
  // reach eve, and tell the user how to send it instead of dropping it silently.
  await io.deleteSecret(chatId, msg.message_id);
  await io.reply(chatId, a?.file
    ? tr("Send client_secret.json as text or attach the .json file — not a photo.", "Пришли client_secret.json текстом или прикрепи .json-файл — не фото.")
    : tr("Send it as text, please.", "Пришли это, пожалуйста, текстом."));
  return true;
}

// Control commands are handled by the BRIDGE (out-of-band) — they work even if the agent is stuck.
// Trusted IDs only. Returns true if the command was handled (we do NOT deliver it to eve).
async function handleControl(update) {
  // Bridge-owned inline-button taps (/update, /model, /think) — not eve HITL callbacks.
  const cq = update.callback_query;
  if (cq && typeof cq.data === "string") {
    if (cq.data.startsWith("iva_update:")) return handleUpdateCallback(cq);
    // Wizard errors must not escape: an uncaught throw would crash the bridge and
    // re-poll the update after restart. Consume the tap either way.
    if (cq.data.startsWith("iva_model:") || cq.data.startsWith("iva_think:")) {
      return handleWizardCallback(cq).catch((e) => {
        log("wizard callback error:", e.message);
        return true;
      });
    }
    // /menu: тот же принцип consume-on-error — тап меню всегда проглатывается (в eve не уходит).
    if (cq.data.startsWith("iva_menu:")) {
      return menu.onCallback(cq).catch((e) => {
        log("menu callback error:", e.message);
        return true;
      });
    }
  }
  const msg = update.message;
  const text = (msg?.text || "").trim();
  // A pending flow (menu screen or /model wizard) awaiting input claims this user's next message
  // (a key must never reach eve); a command aborts the wait — a silently still-visible prompt would
  // invite pasting the key later, when nothing intercepts it. This runs BEFORE the busy-buffer gate
  // (below), so a capture works even mid-turn. Non-text is intercepted only while awaiting a SECRET
  // (or a file-capable secret): a document/photo could be the secret itself and must not reach eve.
  // A non-secret await (e.g. the memory interview) lets a non-text message fall through unchanged.
  if (msg?.from) {
    const pending = getWizard(msg.chat?.id, String(msg.from.id));
    const a = pending?.awaitText;
    if (a) {
      if (text.startsWith("/")) {
        await endWizard(pending, tr("Cancelled — no longer waiting for input.", "Отменено — ожидание ввода снято.")).catch(() => {});
      } else if (text) {
        if (pending.flow === "menu") {
          // Menu screens own their capture (interview / key intake / gws JSON / ubcred).
          return menu.onText(msg, pending).catch((e) => {
            log("menu capture error:", e.message); // e.message never contains a secret value
            return true;
          });
        }
        // /model wizard key intake — consume the update even on failure (the key must never
        // be re-polled into eve). handleKeyMessage stays the wizard's own handler.
        return handleKeyMessage(msg, pending).catch((e) => {
          log("wizard key error:", e.message); // e.message never contains the key value
          return true;
        });
      } else if (a.secret || a.file) {
        // Non-text while awaiting a secret — never let it reach eve (delete-first inside).
        return handleAwaitNonText(msg, pending).catch((e) => {
          log("menu attachment capture error:", e.message); // never contains the secret value
          return true;
        });
      }
      // else: non-secret await + non-text → fall through so eve handles it normally.
    }
  }
  if (!text.startsWith("/")) return false;
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  if (!["/menu", "/help", "/stop", "/usage", "/restart", "/new", "/update", "/model", "/think"].includes(cmd)) return false;
  const from = String(msg?.from?.id ?? "");
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return false; // untrusted — let eve drop it
  const chatId = msg?.chat?.id;
  // /menu — open the nested settings menu (out-of-band; errors consumed, never reach eve).
  if (cmd === "/menu") {
    await menu.open(chatId, from).catch((e) => log("menu error:", e.message));
    return true;
  }
  if (cmd === "/help") {
    await reply(chatId, helpText());
    return true;
  }
  // /stop — interrupt the current turn. Same path as the ⏹ Stop button: we synthesize a
  // callback_query with data "iva_cancel"; the channel resolves sessionId from run-status
  // and resumes eve's cancel hook. Out-of-band so it reaches a busy agent (an ordinary
  // message would be queued by the gate below and never processed).
  if (cmd === "/stop") {
    const key = chatKey(update);
    if (!key || !isRunning(key)) {
      await reply(chatId, tr("Nothing is running right now.", "Сейчас ничего не выполняется."));
      return true;
    }
    await deliver({
      update_id: 0,
      callback_query: {
        id: `ivastop-${Date.now()}`, // synthetic: answerCallbackQuery on it fails, channel tolerates
        from: msg.from,
        message: msg, // carries chat/thread — the channel derives chatKey from here
        data: "iva_cancel",
      },
    });
    return true;
  }
  // /usage — token spend from data/usage.jsonl. Out-of-band and FREE (we don't call the model).
  if (cmd === "/usage") {
    const arg = text.split(/\s+/).slice(1).join(" ");
    try {
      const agg = summarize(readEntries(), { window: parseWindow(arg), now: Date.now(), tz: process.env.ASSISTANT_TIMEZONE });
      await reply(chatId, formatUsageReport(agg));
    } catch (e) {
      await reply(chatId, "Couldn't read the usage log: " + e.message);
    }
    return true;
  }
  // /update — check upstream; if newer, offer inline Update/Skip buttons. Out-of-band.
  if (cmd === "/update") {
    await handleUpdateCheck(chatId);
    return true;
  }
  // /model, /think — provider/model/effort wizard (writes .env; applied on restart).
  if (cmd === "/model") {
    await handleModelCmd(chatId, from).catch((e) => log("wizard /model error:", e.message));
    return true;
  }
  if (cmd === "/think") {
    await handleThinkCmd(chatId, from).catch((e) => log("wizard /think error:", e.message));
    return true;
  }
  // /new retires only this exact Telegram session. /restart does the same first,
  // then restarts the agent process; histories and queues of other chats survive.
  const key = chatKey(update);
  const continuationToken = key
    ? continuationTokenForControl(update, getChatStatus(key), BOT_USER_ID)
    : null;
  const resetCopy = resetMessageCopy(cmd, await readEnvFresh(ENV_PATH));
  const status = await reply(chatId, resetCopy.pending);
  if (!continuationToken || !key) {
    if (status) {
      await edit(
        chatId,
        status.message_id,
        tr(
          "⚠️ I couldn't identify this conversation. In a group, reply /new to Iva's latest message.",
          "⚠️ Не удалось определить этот диалог. В группе ответьте /new на последнее сообщение Iva.",
        ),
      );
    }
    return true;
  }

  const clearsPrivateQueue = msg?.chat?.type === "private";
  try {
    await performScopedReset(key, continuationToken, {
      // Group/forum queues are keyed only by chat/topic while Eve sessions also
      // include conversationId. Clearing the shared queue here would lose
      // messages belonging to other group conversation anchors.
      clearQueue: clearsPrivateQueue,
    });
  } catch (e) {
    log(`scoped reset ${e.resetPhase ?? "unknown"} failed for ${key}:`, e.message);
    if (status) {
      await edit(
        chatId,
        status.message_id,
        e.resetPhase === "remote"
          ? tr(
              "⚠️ Couldn't confirm this conversation reset. Recovery will retry automatically.",
              "⚠️ Не удалось подтвердить сброс диалога. Восстановление повторит его автоматически.",
            )
          : tr(
              "⚠️ Conversation reset recovery is incomplete. Iva will retry it before accepting queued work.",
              "⚠️ Восстановление после сброса не завершено. Iva повторит его до приёма задач из очереди.",
            ),
      );
    }
    // A private reset request is ambiguous after any I/O failure: Eve may have
    // committed it even when the response was lost. Stop this polling process so
    // startup reconciliation consumes the durable intent before any old head.
    if (clearsPrivateQueue) throw e;
    return true;
  }

  if (cmd === "/restart" && !(await sc("restart", "iva.service"))) {
    if (status) {
      await edit(
        chatId,
        status.message_id,
        tr(
          "⚠️ Conversation reset, but Iva couldn't restart.",
          "⚠️ Диалог сброшен, но перезапустить Iva не удалось.",
        ),
      );
    }
    return true;
  }
  if (status) await edit(chatId, status.message_id, resetCopy.complete);
  return true;
}

export { registerBotCommands, handleControl };
