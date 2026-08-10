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
  "session.waiting": (
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

async function emitSessionWaiting(options: EventOptions) {
  const context = eventContext(options);
  await contextStorage.run(context.ctx, () =>
    adapter["session.waiting"]({}, context.value),
  );
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

// session.waiting — страховка при потерянном terminal-событии (краш хода): парковка
// сессии обязана не только снять busy-флаг, но и удалить осиротевший «Работаю…/Стоп»,
// иначе индикатор висит в чате до ручной уборки.
test("session.waiting after a lost terminal event deletes the orphan working indicator", async () => {
  const chatId = "704";
  const sessionId = "parked-session-lost-terminal";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
    statusMessageId: 66,
    ingressId: "ingress-704",
  });
  const before = apiCalls.length;

  await emitSessionWaiting({ chatId, sessionId });

  const status = getChatStatus(key);
  assert.equal(status!.status, "idle");
  assert.equal(status!.sessionId, undefined);
  assert.equal(status!.turnId, undefined);
  assert.equal(status!.statusMessageId, undefined);
  assert.equal(status!.ingressId, undefined);
  const deletes = callsSince(before, "deleteMessage");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].body!.message_id, 66);
});

test("session.waiting after normal cleanup or for a stale session is a no-op", async () => {
  const chatId = "705";
  const key = chatKeyOf(chatId);
  // Обычный финал: turn.completed уже прибрал статус — парковка ничего не трогает.
  setChatStatus(key, {
    status: "idle",
    sessionId: null,
    statusMessageId: null,
  });
  const before = apiCalls.length;
  await emitSessionWaiting({ chatId, sessionId: "already-cleaned" });
  assert.equal(callsSince(before, "deleteMessage").length, 0);
  assert.equal(getChatStatus(key)!.status, "idle");

  // Запоздавший session.waiting старой сессии не должен убить бегущий новый ход.
  setChatStatus(key, {
    status: "running",
    sessionId: "newer-session",
    turnId: "turn_1",
    statusMessageId: 90,
  });
  await emitSessionWaiting({ chatId, sessionId: "stale-session" });
  const status = getChatStatus(key);
  assert.equal(status!.status, "running");
  assert.equal(status!.sessionId, "newer-session");
  assert.equal(status!.statusMessageId, 90);
  assert.equal(callsSince(before, "deleteMessage").length, 0);
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

// Уведомление о сбое собирается из runtime-контента (текст провайдера, errorId), и до
// Bot API оно доходит через шов канала (noticeSender). Планты — под generic_key и под
// формат телеграм-токена; проверяем то, что реально ушло в теле запроса.
const PLANTED_KEY = `api_key=${"z".repeat(24)}`;
const PLANTED_BOT_TOKEN = `1234567890:${"A".repeat(35)}`;

function mutedConsole() {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

test("turn.failed redacts a provider key before it reaches Bot API", async () => {
  const chatId = "706";
  const restore = mutedConsole();
  const before = apiCalls.length;
  try {
    await emitTurnFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: "err-key-706" },
        message: `Incorrect API key provided: ${PLANTED_KEY}`,
        sequence: 0,
        turnId: "turn_0",
      },
      { chatId, sessionId: "failed-session-key" },
    );
  } finally {
    restore();
  }

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  const text = String(sends[0].body!.text);
  assert.equal(text.includes("zzzz"), false);
  assert.equal(text.includes("[REDACTED]"), true);
  assert.equal(text.endsWith("Error id: err-key-706"), true);
});

// errorId никто не чистит по дороге: если шов канала снять, ключ уедет в чат целым.
test("turn.failed redacts a secret carried by errorId itself", async () => {
  const chatId = "707";
  const restore = mutedConsole();
  const before = apiCalls.length;
  try {
    await emitTurnFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: PLANTED_KEY },
        message: "Provider returned a strange response",
        sequence: 0,
        turnId: "turn_0",
      },
      { chatId, sessionId: "failed-session-error-id" },
    );
  } finally {
    restore();
  }

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  const text = String(sends[0].body!.text);
  assert.equal(text.includes("zzzz"), false);
  assert.equal(text.endsWith("Error id: [REDACTED]"), true);
});

// Худший вход разом: пусто в message, многострочный стек и оба секрета в одной ошибке.
test("session.failed survives an empty error and redacts a multi-line one", async () => {
  const restore = mutedConsole();
  const emptyBefore = apiCalls.length;
  try {
    await emitSessionFailed(
      { code: "MODEL_CALL_FAILED", message: "", sessionId: "failed-empty" },
      { chatId: "708", sessionId: "failed-empty" },
    );
    const empty = callsSince(emptyBefore, "sendMessage");
    assert.equal(empty.length, 1);
    assert.equal(empty[0].body!.text, "Turn failed: Unknown provider error");

    const before = apiCalls.length;
    await emitSessionFailed(
      {
        code: "MODEL_CALL_FAILED",
        details: { errorId: "err-hostile-709" },
        message: `bot ${PLANTED_BOT_TOKEN} rejected the call: ${PLANTED_KEY}\nat stack ${PLANTED_KEY}`,
        sessionId: "failed-hostile",
      },
      { chatId: "709", sessionId: "failed-hostile" },
    );
    const sends = callsSince(before, "sendMessage");
    assert.equal(sends.length, 1);
    const text = String(sends[0].body!.text);
    assert.equal(text.includes("zzzz"), false);
    assert.equal(text.includes("AAAA"), false);
    assert.equal(text.includes("at stack"), false);
    assert.equal(text.includes("[REDACTED]"), true);
  } finally {
    restore();
  }
});
