import { telegramContinuationToken } from "eve/channels/telegram";
import { toChannelLocalToken } from "./telegram-continuation-token.mjs";

function storedToken(status) {
  const token = status?.continuationToken;
  if (typeof token !== "string" || token.length === 0) return null;
  // Статусы, записанные до фикса #110, хранят токен с именем канала впереди.
  // Нормализация на чтении лечит их без ожидания следующей перезаписи.
  return toChannelLocalToken(token);
}

/**
 * Returns the exact channel-local token Eve assigned to this chat/topic.
 * New installs persist it from the Telegram event context. The private-chat
 * fallback makes upgrades from pre-0.27 Eve work before the first new turn.
 */
export function continuationTokenForControl(update, status, botUserId) {
  const message = update?.message ?? update?.callback_query?.message;
  if (!message) return storedToken(status);
  const chatId = message?.chat?.id;
  if (chatId === undefined) return null;
  const messageThreadId = message?.message_thread_id;

  // In groups, a reply explicitly selects one Eve conversation anchor and
  // therefore takes precedence over the last active token for this topic.
  // Match Iva's own numeric bot id, not just any Telegram bot.
  const reply = message.reply_to_message;
  if (message.chat?.type !== "private" && reply !== undefined) {
    if (
      reply.from?.is_bot === true &&
      String(reply.from.id) === String(botUserId) &&
      reply.message_id !== undefined
    ) {
      return telegramContinuationToken({
        chatId,
        messageThreadId,
        conversationId: reply.message_id,
      });
    }
    // An explicit reply to another actor must not silently reset the last Iva
    // conversation merely because that topic still has a stored status token.
    return null;
  }

  const stored = storedToken(status);
  if (stored !== null) return stored;

  if (message.chat?.type === "private") {
    return telegramContinuationToken({ chatId, messageThreadId });
  }

  // A standalone legacy group command cannot reconstruct the old conversation
  // anchor until the new event handler has persisted its exact token.
  return null;
}

/**
 * Calls Iva's Telegram-owned reset route. Both statuses are idempotent success:
 * a replayed Telegram update sees no active owner after the first reset.
 */
export async function requestTelegramReset({
  url,
  secret,
  continuationToken,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify({ continuationToken }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Eve reset route returned HTTP ${response.status}`);

  const body = await response.json();
  if (
    body?.ok !== true ||
    (body.status !== "reset" && body.status !== "no_active_session")
  ) {
    throw new Error("Eve reset route returned an invalid response");
  }
  return body;
}
