/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-telegram-failures-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "failure-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "failure-test-secret";

type ApiBody = Record<string, unknown> & {
  chat_id?: unknown;
  message_id?: unknown;
  text?: unknown;
};
type ApiCall = { method: string | undefined; body: ApiBody | undefined };
type HeldSend = {
  chatId: string;
  release: Promise<void>;
  startedResolve: () => void;
};
type EventOptions = {
  chatId: string;
  sessionId: string;
  continuationToken?: string;
};
type FailureAdapter = {
  state?: Record<string, unknown>;
  createAdapterContext: (base: {
    ctx: unknown;
    session: {
      continuationToken: string;
      setContinuationToken: (token: string) => void;
    };
    state: Record<string, unknown>;
  }) => unknown;
  "turn.failed": (
    data: Record<string, unknown>,
    context: unknown,
  ) => void | Promise<void>;
  "session.failed": (
    data: Record<string, unknown>,
    context: unknown,
  ) => void | Promise<void>;
};

const apiCalls: ApiCall[] = [];
let heldSend: HeldSend | undefined;
globalThis.fetch = async (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the original mock's exact String coercion.
  const requestUrl = String(url);
  const method = new URL(requestUrl).pathname.split("/").at(-1);
  const body: ApiBody | undefined = init.body
    ? (JSON.parse(
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the original mock's exact String coercion.
        String(init.body),
      ) as ApiBody)
    : undefined;
  apiCalls.push({ method, body });
  const hold = heldSend;
  if (method === "sendMessage" && hold?.chatId === String(body?.chat_id)) {
    hold.startedResolve();
    await hold.release;
    if (heldSend === hold) heldSend = undefined;
  }
  return Response.json({
    ok: true,
    result: {
      message_id: 1000 + apiCalls.length,
      chat: { id: body?.chat_id ?? 7, type: "private" },
    },
  });
};

const telegramTestModule = "../agent/channels/telegram.ts?failure-events-test";
const [
  { default: channel },
  { chatKeyOf, getChatStatus, setChatStatus },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import(telegramTestModule) as Promise<
    typeof import("../agent/channels/telegram.ts")
  >,
  import("#lib/run-status.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);

const adapter = (channel as unknown as { adapter: FailureAdapter }).adapter;

after(() => rmSync(dataDir, { recursive: true, force: true }));

function eventContext({
  chatId,
  sessionId,
  continuationToken = `telegram:${chatId}::`,
}: EventOptions) {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: "turn_0", sequence: 0 },
  });
  const session = {
    continuationToken,
    setContinuationToken(token: string) {
      this.continuationToken = token;
    },
  };
  const state = {
    ...adapter.state,
    chatId: String(chatId),
    chatType: "private",
    messageThreadId: null,
  };
  return {
    ctx,
    value: adapter.createAdapterContext({ ctx, session, state }),
  };
}

async function emitTurnFailed(
  data: Record<string, unknown>,
  options: EventOptions,
) {
  const context = eventContext(options);
  await contextStorage.run(context.ctx, () =>
    adapter["turn.failed"](data, context.value),
  );
}

async function emitSessionFailed(
  data: Record<string, unknown>,
  options: EventOptions,
) {
  const context = eventContext(options);
  await adapter["session.failed"](data, context.value);
}

function callsSince(index: number, method: string) {
  return apiCalls.slice(index).filter((call) => call.method === method);
}

function holdSend(chatId: string) {
  let startedResolve!: () => void;
  let releaseResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  heldSend = {
    chatId: String(chatId),
    release,
    startedResolve,
  };
  return { release: releaseResolve, started };
}

test("turn.failed posts a humanized error with error id even when finishStatus CAS misses", async () => {
  const chatId = "701";
  const sessionId = "failed-session-cas-miss";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "newer-session",
    turnId: "turn_newer",
  });
  const before = apiCalls.length;
  const turnData = {
    code: "MODEL_CALL_FAILED",
    details: {
      errorId: "err-limit-701",
      statusCode: 429,
      upstreamMessage: "5-hour usage limit reached. Resets in 3hr 59min.",
    },
    message: "Request rejected",
    sequence: 0,
    turnId: "turn_0",
  };

  await emitTurnFailed(turnData, { chatId, sessionId });

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  assert.equal(
    sends[0].body!.text,
    "Provider limit exhausted - resets in 3hr 59min; wait or switch models: /model\n\nError id: err-limit-701",
  );
  assert.equal(getChatStatus(key)!.sessionId, "newer-session");

  await emitSessionFailed(
    {
      code: turnData.code,
      details: turnData.details,
      message: turnData.message,
      sessionId,
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 1);
});

test("session.failed clears its run-status and deduplicates repeated delivery", async () => {
  const chatId = "702";
  const sessionId = "terminal-session-cleanup";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
    statusMessageId: 55,
  });
  const before = apiCalls.length;
  const data = {
    code: "MODEL_CALL_FAILED",
    details: { errorId: "err-billing-702", statusCode: 402 },
    message: "Request rejected",
    sessionId,
  };

  await emitSessionFailed(data, { chatId, sessionId });

  const status = getChatStatus(key);
  assert.equal(status!.status, "idle");
  assert.equal(status!.sessionId, undefined);
  assert.equal(status!.turnId, undefined);
  assert.equal(callsSince(before, "deleteMessage").length, 1);
  assert.equal(callsSince(before, "deleteMessage")[0].body!.message_id, 55);
  assert.equal(callsSince(before, "sendMessage").length, 1);
  assert.equal(
    callsSince(before, "sendMessage")[0].body!.text,
    "Provider balance/plan exhausted - top up or switch models: /model\n\nError id: err-billing-702",
  );

  await emitSessionFailed(data, { chatId, sessionId });
  assert.equal(callsSince(before, "sendMessage").length, 1);
});

test("turn.failed claims notification before an overlapping session.failed can post", async () => {
  const chatId = "703";
  const sessionId = "terminal-session-overlap";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
  });
  const before = apiCalls.length;
  const details = { errorId: "err-upstream-703" };
  const hold = holdSend(chatId);
  const turn = emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details,
      message: "Upstream request failed",
      sequence: 0,
      turnId: "turn_0",
    },
    { chatId, sessionId },
  );
  await hold.started;

  await emitSessionFailed(
    {
      code: "MODEL_CALL_FAILED",
      details,
      message: "Upstream request failed",
      sessionId,
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 1);
  hold.release();
  await turn;
  assert.equal(callsSince(before, "sendMessage").length, 1);
});
