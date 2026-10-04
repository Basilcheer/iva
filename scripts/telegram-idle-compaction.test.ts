/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; the fetch double keeps the async boundary. */
// Свёртка между ходами на живом шве канала: хук шага пишет вход, канал на turn.completed
// зовёт собственный compact-роут с секретом вебхука, а роут — compact() eve по точной сессии.
// Сообщение, принятое во время свёртки, получает ранний статус с подписью. Двойник стоит
// только на внешних границах: Bot API и сессия eve; вызов роута идёт настоящим обработчиком.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import type {
  AttachSessionFn,
  ChannelSource,
  RouteHandlerArgs,
  Session,
} from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";

const dataDir = mkdtempSync(join(tmpdir(), "iva-idle-compaction-"));
const vault = mkdtempSync(join(tmpdir(), "iva-idle-compaction-vault-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_VAULT_DIR = vault;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "idle-compaction-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "idle-compaction-test-secret";
process.env.TELEGRAM_BOT_USERNAME = "my_bot";
delete process.env.ASSISTANT_HOST;
delete process.env.IVA_PORT;
after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
});

type ApiCall = { method: string; body: Record<string, unknown> | undefined };
const apiCalls: ApiCall[] = [];
const compactCalls: { sessionId: string; secret: string | null }[] = [];
let compactStatus: "accepted" | "no_active_session" | "down" = "accepted";
let compactRoute: (request: Request) => Promise<Response> = async () =>
  new Response("route is not loaded", { status: 500 });

const COMPACT_URL = "http://127.0.0.1:8723/eve/v1/telegram/compact";
globalThis.fetch = async (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever the caller passes.
  const href = String(url);
  if (href === COMPACT_URL) {
    if (compactStatus === "down") throw new Error("connect ECONNREFUSED");
    return compactRoute(new Request(href, init));
  }
  const method = new URL(href).pathname.split("/").at(-1) ?? "";
  const body = init.body
    ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
      (JSON.parse(String(init.body)) as Record<string, unknown>)
    : undefined;
  apiCalls.push({ method, body });
  return Response.json({
    ok: true,
    result: { message_id: 500 + apiCalls.length, chat: { id: 1 } },
  });
};

type Handler = (data: Record<string, unknown>, context: unknown) => unknown;
type Adapter = {
  state: Record<string, unknown>;
  createAdapterContext: (base: {
    ctx: unknown;
    session: unknown;
    state: Record<string, unknown>;
  }) => unknown;
  "turn.started": Handler;
  "turn.completed": Handler;
};

const channelModule = "../agent/channels/telegram.ts?idle-compaction-test";
const [
  { default: channel },
  { default: usageHook },
  { providerConfig },
  { idleCompactionLimit },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import(channelModule) as Promise<
    typeof import("../agent/channels/telegram.ts")
  >,
  import("../agent/hooks/usage.ts"),
  import("../agent/provider.ts"),
  import("../agent/lib/compaction.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);
const adapter = (channel as unknown as { adapter: Adapter }).adapter;
const route = (path: string) => {
  const found = channel.routes.find((candidate) => candidate.path === path);
  if (!found || found.transport === "websocket")
    throw new Error(`Telegram channel did not expose ${path}`);
  return found;
};
const webhook = route("/eve/v1/telegram");
const compact = route("/eve/v1/telegram/compact");
const unused = () => {
  throw new Error("not used by this path");
};
const attachSession = ((sessionId: string) => ({
  id: sessionId,
  compact: async () => {
    return compactStatus === "accepted"
      ? { sessionId, status: "accepted" as const }
      : { status: "no_active_session" as const };
  },
})) as AttachSessionFn;
compactRoute = async (request) => {
  const copy = request.clone();
  const { sessionId } = (await copy.json()) as { sessionId: string };
  compactCalls.push({
    sessionId,
    secret: request.headers.get("x-telegram-bot-api-secret-token"),
  });
  return compact.handler(request, {
    attachSession,
  } as unknown as RouteHandlerArgs<TelegramChannelState>);
};

const LIMIT = idleCompactionLimit(providerConfig.contextWindow);
const hookEvents = (
  usageHook as unknown as {
    events: Record<string, (event: unknown, ctx: unknown) => void>;
  }
).events;
// Просьба о свёртке уходит без ожидания: даём её промису дойти до конца.
const settle = async () => {
  for (let i = 0; i < 20; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

let seq = 0;
beforeEach(() => {
  apiCalls.length = 0;
  compactCalls.length = 0;
  compactStatus = "accepted";
});

function step(sessionId: string, tokens: number) {
  hookEvents["step.completed"](
    {
      data: {
        stepIndex: 0,
        turnId: "turn_x",
        usage: { inputTokens: tokens, outputTokens: 10, cacheReadTokens: 0 },
      },
    },
    { session: { id: sessionId }, channel: { kind: "channel:telegram" } },
  );
}

/** Один ход в порядке eve: turn.started → шаги → turn.completed. */
async function turn(sessionId: string, chatId: number, steps: number[]) {
  const turnId = `turn_${++seq}`;
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: turnId, sequence: seq },
  });
  const context = adapter.createAdapterContext({
    ctx,
    session: {
      id: sessionId,
      auth: { current: null, initiator: null },
      continuation: { token: `telegram:${chatId}::`, rekey() {} },
    },
    state: {
      ...adapter.state,
      chatId: String(chatId),
      chatType: "private",
      messageThreadId: null,
    },
  });
  await contextStorage.run(ctx, async () => {
    await adapter["turn.started"]({ sequence: seq, turnId }, context);
    for (const tokens of steps) step(sessionId, tokens);
    await adapter["turn.completed"]({ sequence: seq, turnId }, context);
  });
  await settle();
}

/** Сообщение владельца через настоящий вебхук канала; возвращает число доставок в eve. */
async function incoming(chatId: number, sessionId: string): Promise<number> {
  let sends = 0;
  const pending: Promise<unknown>[] = [];
  const session = { id: sessionId } as Session;
  const source = {
    send: async () => {
      sends += 1;
      return session;
    },
    respond: async () => session,
    cancel: unused,
    compact: unused,
    clear: unused,
    reset: unused,
  } as unknown as ChannelSource<TelegramChannelState>;
  const response = await webhook.handler(
    new Request("http://local/eve/v1/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "idle-compaction-test-secret",
      },
      body: JSON.stringify({
        update_id: ++seq,
        message: {
          message_id: 100 + seq,
          chat: { id: chatId, type: "private" },
          from: { id: 9, is_bot: false, username: "owner" },
          text: "ещё вопрос",
        },
      }),
    }),
    {
      attachSession: () => session,
      from: () => source,
      resolveSession: async () => session,
      to: unused,
      params: {},
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      requestIp: "127.0.0.1",
    },
  );
  assert.equal(response.status, 200);
  await Promise.all(pending);
  return sends;
}

const statusMarkdown = () =>
  apiCalls
    .filter((call) => call.method === "sendRichMessage")
    .map((call) =>
      String(
        (call.body?.rich_message as { markdown?: unknown } | undefined)
          ?.markdown,
      ),
    );
const NOTE = "Compacting the conversation, I'll answer in a moment.";

test("ход под порогом свёртку не просит, ход на пороге просит её у своей сессии с секретом вебхука, после уборки статуса", async () => {
  await turn("s-low", 41, [LIMIT - 1]);
  assert.deepEqual(compactCalls, []);

  await turn("s-over", 42, [1_000, LIMIT]);
  assert.deepEqual(compactCalls, [
    { sessionId: "s-over", secret: "idle-compaction-test-secret" },
  ]);
  assert.ok(
    apiCalls.some((call) => call.method === "deleteMessage"),
    "статус хода убран",
  );
});

test("сообщение во время свёртки доходит до eve и получает ранний статус с подписью; после конца свёртки подписи нет", async () => {
  await turn("s-note", 43, [LIMIT]);
  apiCalls.length = 0;
  assert.equal(await incoming(43, "s-note"), 1, "сообщение доставлено в eve");
  const [status] = statusMarkdown();
  assert.ok(status?.endsWith(` ${NOTE}`), status);
  assert.ok(!status?.includes("<tg-button"), "ход ещё не начался: без «Стоп»");

  // Свёртка кончилась, начался и закончился ход по этому сообщению (ниже порога).
  hookEvents["compaction.completed"](
    { data: {} },
    { session: { id: "s-note" } },
  );
  await turn("s-note", 43, [LIMIT - 1]);
  apiCalls.length = 0;
  assert.equal(await incoming(43, "s-note"), 1);
  assert.ok(!statusMarkdown().some((markdown) => markdown.includes(NOTE)));
});

test("подпись получает только чат, чья сессия сворачивается", async () => {
  await turn("s-own", 44, [LIMIT]);
  apiCalls.length = 0;
  assert.equal(await incoming(45, "s-other"), 1);
  assert.ok(!statusMarkdown().some((markdown) => markdown.includes(NOTE)));
});

test("сессии уже нет или роут недоступен: ход закончен как обычно, подписи нет, следующий ход просит снова", async () => {
  for (const [status, chatId] of [
    ["no_active_session", 46],
    ["down", 47],
  ] as const) {
    compactStatus = status;
    const sessionId = `s-${status}`;
    await turn(sessionId, chatId, [LIMIT]);
    apiCalls.length = 0;
    assert.equal(await incoming(chatId, sessionId), 1);
    assert.ok(!statusMarkdown().some((markdown) => markdown.includes(NOTE)));
    compactStatus = "accepted";
    compactCalls.length = 0;
    await turn(sessionId, chatId, [LIMIT]);
    assert.equal(compactCalls.length, 1);
  }
});

test("законченная свёртка, которая не помогла, больше не повторяется", async () => {
  await turn("s-stuck", 48, [LIMIT]);
  hookEvents["compaction.completed"](
    { data: {} },
    { session: { id: "s-stuck" } },
  );
  compactCalls.length = 0;
  await turn("s-stuck", 48, [LIMIT, LIMIT + 1]);
  await turn("s-stuck", 48, [LIMIT * 2]);
  assert.deepEqual(compactCalls, []);
});
