/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; async doubles preserve the I/O boundary. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type Event = string | [string, string, number | undefined, string | undefined];
type CaptureMessage = { message_id?: number };
type CaptureState = { flow: unknown; awaitText?: unknown };
type CancelCall = {
  url: string;
  secret: string;
  continuationToken: string;
  turnId?: string;
};
type ControlUpdate = Record<string, unknown>;
type ControlModule = {
  handleAwaitNonText: (
    message: CaptureMessage & Record<string, unknown>,
    pending: CaptureState,
    io: Record<string, unknown>,
  ) => Promise<boolean>;
  handleControl: (
    update: ControlUpdate,
    deps?: {
      replyImpl?: (
        chatId: number | undefined,
        text: string,
      ) => Promise<{ message_id: number } | null>;
      ackImpl?: (id: string, text?: string) => Promise<unknown>;
      cancelImpl?: (input: CancelCall) => Promise<unknown>;
    },
  ) => Promise<boolean>;
  OUT_OF_BAND_COMMANDS: string[];
};
type RunStatusModule = {
  setChatStatus: (chatKey: string, patch: Record<string, unknown>) => void;
};

// Мост читает run-status с диска и берёт allowlist из окружения на импорте, поэтому
// и то и другое ставим ДО загрузки модуля, в свежей data-директории.
const dataDir = mkdtempSync(join(tmpdir(), "iva-control-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "424242:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.IVA_PORT = "8723";
delete process.env.ASSISTANT_HOST;
delete process.env.AGENT_LANGUAGE; // без настроек язык моста — ru

const [controlModule, runStatusModule] = (await Promise.all([
  import(`./control.ts?control-test=${Date.now()}`),
  import(`#lib/run-status.ts?control-test=${Date.now()}`),
])) as [unknown, unknown];
const { handleAwaitNonText, handleControl, OUT_OF_BAND_COMMANDS } =
  controlModule as ControlModule;
const status = runStatusModule as RunStatusModule;

const CANCEL_ROUTE = "http://127.0.0.1:8723/eve/v1/telegram/cancel";
const trustedFrom = { id: 42, is_bot: false };
const chat = { id: 7, type: "private" };

function runningTurn(overrides: Record<string, unknown> = {}) {
  status.setChatStatus("7:", {
    status: "running",
    // Namespaced-токен пишут версии до фикса #110 — наружу обязан уйти channel-local.
    continuationToken: "telegram:7::",
    sessionId: "session-1",
    turnId: "turn-1",
    ...overrides,
  });
}

function stopButton(): ControlUpdate {
  return {
    update_id: 5,
    callback_query: {
      id: "cq-5",
      from: trustedFrom,
      message: { message_id: 4, date: 1, chat },
      data: "iva_cancel",
    },
  };
}

function stopCommand(): ControlUpdate {
  return {
    update_id: 6,
    message: {
      message_id: 6,
      date: 1,
      chat,
      from: trustedFrom,
      text: "/stop",
    },
  };
}

function recordingDeps() {
  const cancels: CancelCall[] = [];
  const acks: Array<[string, string | undefined]> = [];
  const replies: Array<[number | undefined, string]> = [];
  return {
    cancels,
    acks,
    replies,
    deps: {
      cancelImpl: async (input: CancelCall) => {
        cancels.push(input);
        return { ok: true, status: "accepted" };
      },
      ackImpl: async (id: string, text?: string) => {
        acks.push([id, text]);
        return { ok: true };
      },
      replyImpl: async (chatId: number | undefined, text: string) => {
        replies.push([chatId, text]);
        return { message_id: replies.length };
      },
    },
  };
}

test("secret document capture deletes before download and never reaches Eve", async () => {
  const events: Event[] = [];
  const io = {
    deleteSecret: async () => {
      events.push("delete");
      return true;
    },
    download: async () => {
      events.push("download");
      return "client secret";
    },
    deliver: async (
      text: string,
      message: CaptureMessage,
      state: CaptureState,
    ) => {
      events.push([
        "deliver",
        text,
        message.message_id,
        (state.awaitText as { kind?: string } | undefined)?.kind,
      ]);
    },
    reply: async () => assert.fail("must not reply after a successful capture"),
  };

  const consumed = await handleAwaitNonText(
    {
      message_id: 7,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    io,
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, [
    "delete",
    "download",
    ["deliver", "client secret", 7, "gws_client_secret"],
  ]);
});

test("failed deletion consumes a secret document without downloading it", async () => {
  const events: Event[] = [];
  const consumed = await handleAwaitNonText(
    {
      message_id: 8,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    {
      deleteSecret: async () => {
        events.push("delete");
        return false;
      },
      download: async () => assert.fail("must not download a visible secret"),
      deliver: async () => assert.fail("must not deliver a visible secret"),
      reply: async () => assert.fail("deleteSecret owns the failure warning"),
    },
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, ["delete"]);
});

test("the ⏹ Stop button cancels through the channel route, never through Eve", async () => {
  runningTurn();
  const { cancels, acks, replies, deps } = recordingDeps();

  const consumed = await handleControl(stopButton(), deps);

  assert.equal(consumed, true); // тап съеден мостом и в eve не уходит
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      // Токен нормализован: reset/cancel-роуты клеят имя канала сами (#110).
      continuationToken: "7::",
      turnId: "turn-1",
    },
  ]);
  assert.deepEqual(acks, [["cq-5", "Останавливаю…"]]);
  assert.deepEqual(replies, []);
});

test("/stop takes the same door and stays silent while the status message speaks", async () => {
  runningTurn({ sessionId: "session-2", turnId: "turn-2" });
  const { cancels, replies, deps } = recordingDeps();

  const consumed = await handleControl(stopCommand(), deps);

  assert.equal(consumed, true);
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      continuationToken: "7::",
      turnId: "turn-2",
    },
  ]);
  // Подтверждение — переписанное «Работаю…», а не второе сообщение в чате.
  assert.deepEqual(replies, []);
});

test("Stop on an idle chat explains itself and never calls cancel", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });
  const { cancels, acks, replies, deps } = recordingDeps();

  assert.equal(await handleControl(stopButton(), deps), true);
  assert.equal(await handleControl(stopCommand(), deps), true);

  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, [["cq-5", "Сейчас ничего не выполняется."]]);
  assert.deepEqual(replies, [[7, "Сейчас ничего не выполняется."]]);
});

test("a running turn without a continuation token is not cancellable", async () => {
  // Раннее статус-сообщение: ход уже помечен running, но turn.started ещё не записал токен.
  status.setChatStatus("7:", {
    status: "running",
    continuationToken: null,
    sessionId: null,
    turnId: null,
    ingressId: "ingress-1",
  });
  const { cancels, acks, deps } = recordingDeps();

  assert.equal(await handleControl(stopButton(), deps), true);

  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, [["cq-5", "Сейчас ничего не выполняется."]]);
});

test("an untrusted tap on someone else's Stop button is swallowed", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();
  const update = stopButton();
  (update.callback_query as Record<string, unknown>).from = {
    id: 999,
    is_bot: false,
  };

  assert.equal(await handleControl(update, deps), true);
  assert.deepEqual(cancels, []);
  // Спиннер кнопки гасим, но ход чужого пользователя не трогаем и ничего не объясняем.
  assert.deepEqual(acks, [["cq-5", undefined]]);
});

test("a failed cancel request is explained instead of pretending it stopped", async () => {
  runningTurn();
  const acks: Array<[string, string | undefined]> = [];
  const consumed = await handleControl(stopButton(), {
    cancelImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    ackImpl: async (id: string, text?: string) => {
      acks.push([id, text]);
      return { ok: true };
    },
  });

  assert.equal(consumed, true);
  assert.deepEqual(acks, [
    ["cq-5", "Не вышло — возможно, ход уже завершился."],
  ]);
});

test("repeated taps after the turn is gone stay harmless", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();

  await handleControl(stopButton(), deps);
  status.setChatStatus("7:", { status: "idle", sessionId: null, turnId: null });
  await handleControl(stopButton(), deps);
  await handleControl(stopButton(), deps);

  assert.equal(cancels.length, 1);
  assert.deepEqual(acks.slice(1), [
    ["cq-5", "Сейчас ничего не выполняется."],
    ["cq-5", "Сейчас ничего не выполняется."],
  ]);
});

test("/start is answered by the bridge and never becomes a model turn", async () => {
  const { replies, deps } = recordingDeps();
  const consumed = await handleControl(
    {
      update_id: 7,
      message: {
        message_id: 7,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/start",
      },
    },
    deps,
  );

  assert.equal(consumed, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], 7);
  assert.match(replies[0][1], /Iva/u);
  assert.match(replies[0][1], /\/help/u);
  assert.match(replies[0][1], /\/menu/u);
  assert.ok(OUT_OF_BAND_COMMANDS.includes("/start"));
});

test("/start from an untrusted user is not answered by the bridge", async () => {
  const { replies, deps } = recordingDeps();
  const consumed = await handleControl(
    {
      update_id: 8,
      message: {
        message_id: 8,
        date: 1,
        chat,
        from: { id: 999, is_bot: false },
        text: "/start",
      },
    },
    deps,
  );

  assert.equal(consumed, false); // дальше его молча уронит allowlist входного пайплайна
  assert.deepEqual(replies, []);
});

test("malformed update callback is not claimed as a local control", async () => {
  const methods: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    methods.push(url.split("/").at(-1) ?? "");
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const consumed = await handleControl({
      update_id: 9,
      callback_query: {
        id: "cq-invalid-update",
        from: trustedFrom,
        message: { message_id: 9, date: 1, chat },
        data: "iva_update:do-now",
      },
    });

    assert.equal(consumed, false);
    assert.deepEqual(methods, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a falsey local reply does not authorize offset acknowledgement", async () => {
  const consumed = await handleControl(
    {
      update_id: 10,
      message: {
        message_id: 10,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/help",
      },
    },
    { replyImpl: async () => null },
  );

  assert.equal(consumed, false);
});

test("a falsey callback ack does not claim a local control", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });

  const consumed = await handleControl(stopButton(), {
    ackImpl: async () => null,
  });

  assert.equal(consumed, false);
});
