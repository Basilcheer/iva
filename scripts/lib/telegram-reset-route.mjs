import { verifyTelegramRequest } from "eve/channels/telegram";

/**
 * Authenticated Telegram-owned session reset endpoint.
 * `reset` is the route helper Eve binds to the containing authored channel,
 * so the raw token resolves in the "telegram" namespace.
 */
export async function handleTelegramResetRequest(req, reset, secretToken) {
  let raw;
  try {
    raw = await verifyTelegramRequest(req, { secretToken });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }

  let continuationToken;
  try {
    continuationToken = JSON.parse(raw)?.continuationToken;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (typeof continuationToken !== "string" || continuationToken.length === 0) {
    return new Response("continuationToken is required", { status: 400 });
  }

  const result = await reset({
    continuationToken,
    reason: "Telegram recovery command",
  });
  return Response.json({ ok: true, ...result });
}
