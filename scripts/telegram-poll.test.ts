/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and the doubles intentionally retain asynchronous production boundaries. */
import assert from "node:assert/strict";
import { test } from "node:test";

type Update = {
  update_id: number;
  message?: { [key: string]: unknown };
  callback_query?: { [key: string]: unknown };
  [key: string]: unknown;
};
type StatusRecord = {
  status: string;
  generation: number;
  updatedAt: number;
  [key: string]: unknown;
};
type InFlight = { state: string };
type AcceptanceFailure = {
  kind: string;
  status: string | number;
  attempt: number;
};
type DeliverOptions = {
  timeoutMs?: number;
  retryAcceptanceTimeout?: boolean;
  onAcceptanceFailure: (failure: AcceptanceFailure) => Promise<void>;
};
type RouteOptions = {
  chatKeyImpl: (update: Update) => string;
  loadQueueImpl: () => Promise<{
    version: number;
    queues: Record<string, unknown>;
  }>;
  runningImpl: (chatKey: string) => boolean;
  inFlight: Map<string, InFlight>;
  queueCountImpl: () => number;
  replyToBotImpl: (message: unknown) => boolean;
  shouldQueueImpl: (update: Update) => boolean;
  enqueueImpl: (chatKey: string, update: Update) => Promise<{ count: number }>;
  acknowledgeImpl: (update: Update, count: number) => Promise<void>;
  deliverImpl: (update: Update, options: DeliverOptions) => Promise<boolean>;
  statusImpl: (chatKey: string) => StatusRecord | null;
  setStatusIfImpl: (
    chatKey: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  sendFailureImpl: (chatKey: string, text: string) => Promise<unknown>;
  deleteMessageImpl: (chatKey: string, messageId: number) => Promise<unknown>;
  now: () => number;
  trImpl: (english: string, russian: string) => string;
  logImpl: (...parts: unknown[]) => void;
};
type ReaperStatus = { chatKey: string; status: StatusRecord };
type ReaperOptions = {
  listStatusesImpl: () => Promise<ReaperStatus[]>;
  setStatusIfImpl: (
    chatKey: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  resetImpl: (chatKey: string, token: string) => Promise<unknown>;
  sendImpl: (chatKey: string, text: string) => Promise<unknown>;
  deleteMessageImpl: (chatKey: string, messageId: number) => Promise<unknown>;
  now: () => number;
  inFlight: Map<string, InFlight>;
  staleMs: number;
  trImpl: (english: string, russian: string) => string;
  logImpl: (...parts: unknown[]) => void;
};
type NonTextIo = {
  deleteSecret: (chatId: unknown, messageId: number) => Promise<boolean>;
  reply: (chatId: unknown, text: string) => Promise<void>;
  download: (fileId: string) => Promise<string>;
  deliver: (text: string) => Promise<void>;
};
type WizardState = Record<string, unknown>;
type WizardSaveDeps = {
  readEnv: () => Promise<Record<string, string>>;
  validate: (selection: WizardState) => Promise<unknown>;
  write: (updates: Record<string, string | null>) => Promise<unknown>;
};
type PollModule = {
  readCappedStream: (body: unknown, maxBytes: number) => Promise<string | null>;
  handleAwaitNonText: (
    message: unknown,
    pending: unknown,
    io: NonTextIo,
  ) => Promise<boolean>;
  isStaleWizard: (state: WizardState | null, messageId: number) => boolean;
  wizardActionAllowed: (state: WizardState, action: string) => boolean;
  selectWizardModel: (state: WizardState, rawIndex: string) => unknown;
  selectWizardEffort: (state: WizardState, value: string) => boolean;
  runWizardRequest: (
    state: WizardState,
    request: () => Promise<unknown>,
    isCurrent: (candidate: WizardState) => boolean,
  ) => Promise<unknown>;
  resolveThinkCatalogLoad: (
    state: WizardState,
    result: { ok: boolean; error?: unknown },
    showError: (state: WizardState, error: unknown) => Promise<void>,
  ) => Promise<unknown>;
  reapStaleRuns: (options: ReaperOptions) => Promise<number>;
  routeMessageUpdate: (
    update: Update,
    options: RouteOptions,
  ) => Promise<string>;
  selectableWizardOptions: (
    options: Array<{ id: string; [key: string]: unknown }>,
    current: string,
  ) => Array<{ id: string; [key: string]: unknown }>;
  validateAndSaveWizard: (
    state: WizardState,
    deps: WizardSaveDeps,
  ) => Promise<void>;
  main: () => Promise<void>;
};

// poller/main.ts reads env at import, while the permanent telegram-poll.mjs shim delegates
// through a direct-execution guard. A dummy token keeps the API base a harmless string.
process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
delete process.env.TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS;
const directMainModule = await import("./poller/main.ts");
const pollModulePath = "./telegram-poll.mjs";
const {
  readCappedStream,
  handleAwaitNonText,
  isStaleWizard,
  wizardActionAllowed,
  selectWizardModel,
  selectWizardEffort,
  runWizardRequest,
  resolveThinkCatalogLoad,
  reapStaleRuns,
  routeMessageUpdate,
  selectableWizardOptions,
  validateAndSaveWizard,
  main: shimMain,
} = (await import(pollModulePath)) as PollModule;

const enc = new TextEncoder();
function streamOf(...parts: Array<string | Uint8Array>) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts)
        controller.enqueue(typeof p === "string" ? enc.encode(p) : p);
      controller.close();
    },
  });
}

// A recording double for handleAwaitNonText's I/O: captures call order, returns fixed content.
// deleteOk controls whether the (mocked) Telegram deletion is reported as successful.
type Call = [kind: string, ...details: unknown[]];

function recorder(
  content = '{"installed":{}}',
  { deleteOk = true }: { deleteOk?: boolean } = {},
) {
  const calls: Call[] = [];
  const io: NonTextIo = {
    deleteSecret: async (_chatId, id) => {
      calls.push(["delete", id]);
      return deleteOk;
    },
    reply: async (_chatId, text) => {
      calls.push(["reply", text]);
    },
    download: async (fileId) => {
      calls.push(["download", fileId]);
      return content;
    },
    deliver: async (text) => {
      calls.push(["deliver", text]);
    },
  };
  return { calls, io, names: () => calls.map((c) => c[0]) };
}

const routedUpdate = {
  update_id: 10,
  message: {
    message_id: 10,
    date: 1,
    chat: { id: 1, type: "private" },
    from: { id: 42, is_bot: false },
    text: "hello",
  },
};

function routeDeps(overrides: Partial<RouteOptions> = {}): RouteOptions {
  return {
    chatKeyImpl: () => "1:",
    loadQueueImpl: async () => ({ version: 1, queues: {} }),
    runningImpl: () => false,
    inFlight: new Map<string, InFlight>(),
    queueCountImpl: () => 0,
    replyToBotImpl: () => false,
    shouldQueueImpl: () => true,
    enqueueImpl: async () => ({ count: 1 }),
    acknowledgeImpl: async () => {},
    deliverImpl: async () => true,
    statusImpl: () => null,
    setStatusIfImpl: () => null,
    sendFailureImpl: async () => {},
    deleteMessageImpl: async () => {},
    now: () => 1_000,
    trImpl: (_en, ru) => ru,
    logImpl: () => {},
    ...overrides,
  };
}

test("poller main is directly importable without starting the poll loop", () => {
  assert.equal(typeof directMainModule.main, "function");
  assert.equal(directMainModule.main, shimMain);
});

test("routeMessageUpdate enqueues and acknowledges one busy update", async () => {
  let enqueued = 0;
  let acknowledged = 0;
  let delivered = 0;
  const result = await routeMessageUpdate(
    routedUpdate,
    routeDeps({
      runningImpl: () => true,
      enqueueImpl: async (key, update) => {
        enqueued++;
        assert.equal(key, "1:");
        assert.equal(update, routedUpdate);
        return { count: 3 };
      },
      acknowledgeImpl: async (update, count) => {
        acknowledged++;
        assert.equal(update, routedUpdate);
        assert.equal(count, 3);
      },
      deliverImpl: async () => {
        delivered++;
        return true;
      },
    }),
  );

  assert.equal(result, "queued");
  assert.equal(enqueued, 1);
  assert.equal(acknowledged, 1);
  assert.equal(delivered, 0);
});

test("routeMessageUpdate sends one idle update through paced delivery", async () => {
  let delivered = 0;
  const result = await routeMessageUpdate(
    routedUpdate,
    routeDeps({
      deliverImpl: async (update) => {
        delivered++;
        assert.equal(update, routedUpdate);
        return true;
      },
    }),
  );

  assert.equal(result, "delivered");
  assert.equal(delivered, 1);
});

test("a direct acceptance timeout is rejected after one cleanup and notification", async () => {
  let current: StatusRecord = {
    status: "idle",
    generation: 4,
    updatedAt: 900,
  };
  const calls: Call[] = [];
  let deliveries = 0;
  let timeoutReports = 0;
  const result = await routeMessageUpdate(
    routedUpdate,
    routeDeps({
      statusImpl: () => current,
      setStatusIfImpl: (key, expected, patch) => {
        calls.push(["cas", key, expected, patch]);
        current = {
          ...current,
          ...patch,
          generation: current.generation + 1,
          updatedAt: 1_000,
        };
        for (const field of Object.keys(current)) {
          if (current[field] === null) delete current[field];
        }
        return current;
      },
      sendFailureImpl: async (key, text) => calls.push(["send", key, text]),
      deleteMessageImpl: async (key, messageId) =>
        calls.push(["delete", key, messageId]),
      deliverImpl: async (_update, options) => {
        deliveries++;
        assert.equal(options.timeoutMs, 90_000);
        assert.equal(options.retryAcceptanceTimeout, false);
        current = {
          status: "running",
          generation: 5,
          updatedAt: 1_000,
          ingressId: "timed-out-ingress",
          ingressAt: 1_000,
          statusMessageId: 73,
        };
        timeoutReports++;
        await options.onAcceptanceFailure({
          kind: "timeout",
          status: "timeout",
          attempt: 1,
        });
        return false;
      },
    }),
  );

  assert.equal(result, "rejected");
  assert.equal(deliveries, 1);
  assert.equal(timeoutReports, 1);
  assert.equal(calls.filter(([kind]) => kind === "cas").length, 1);
  assert.deepEqual(
    calls.filter(([kind]) => kind === "delete"),
    [["delete", "1:", 73]],
  );
  assert.deepEqual(
    calls.filter(([kind]) => kind === "send"),
    [["send", "1:", "Не получилось обработать сообщение - повтори или /new"]],
  );
});

test("direct acceptance failures clear each matching ingress and notify the chat once", async () => {
  let current: StatusRecord = {
    status: "idle",
    generation: 4,
    updatedAt: 900,
  };
  const calls: Call[] = [];
  const result = await routeMessageUpdate(
    routedUpdate,
    routeDeps({
      statusImpl: () => current,
      setStatusIfImpl: (key, expected, patch) => {
        calls.push(["cas", key, expected, patch]);
        current = {
          ...current,
          ...patch,
          generation: current.generation + 1,
          updatedAt: 1_000,
        };
        for (const field of Object.keys(current)) {
          if (current[field] === null) delete current[field];
        }
        return current;
      },
      sendFailureImpl: async (key, text) => calls.push(["send", key, text]),
      deleteMessageImpl: async (key, messageId) =>
        calls.push(["delete", key, messageId]),
      deliverImpl: async (_update, { onAcceptanceFailure }) => {
        current = {
          status: "running",
          generation: 5,
          updatedAt: 1_000,
          ingressId: "ingress-first",
          ingressAt: 1_000,
          statusMessageId: 71,
        };
        await onAcceptanceFailure({
          kind: "dispatch",
          status: 503,
          attempt: 1,
        });
        assert.equal(
          current.status,
          "idle",
          "the first failed ingress resets immediately",
        );

        current = {
          status: "running",
          generation: 7,
          updatedAt: 1_000,
          ingressId: "ingress-retry",
          ingressAt: 1_000,
          statusMessageId: 72,
        };
        await onAcceptanceFailure({
          kind: "dispatch",
          status: 503,
          attempt: 2,
        });
        assert.equal(
          current.status,
          "idle",
          "a failed bounded retry is cleaned too",
        );
        return false;
      },
    }),
  );

  assert.equal(result, "rejected");
  assert.equal(calls.filter(([kind]) => kind === "cas").length, 2);
  assert.deepEqual(
    calls.filter(([kind]) => kind === "delete"),
    [
      ["delete", "1:", 71],
      ["delete", "1:", 72],
    ],
  );
  assert.deepEqual(
    calls.filter(([kind]) => kind === "send"),
    [["send", "1:", "Не получилось обработать сообщение - повтори или /new"]],
  );
});

test("reply-to-bot bypass clears its failed early status before delivery returns", async () => {
  let current: StatusRecord = {
    status: "running",
    generation: 7,
    updatedAt: 1_900,
    sessionId: "orphaned-session",
  };
  let resetBeforeReturn = false;
  let notifications = 0;
  const result = await routeMessageUpdate(
    routedUpdate,
    routeDeps({
      replyToBotImpl: () => true,
      loadQueueImpl: async () => {
        throw new Error("reply-to-bot must bypass the busy queue");
      },
      now: () => 2_000,
      statusImpl: () => current,
      setStatusIfImpl: (_key, _expected, patch) => {
        current = {
          ...current,
          ...patch,
          generation: current.generation + 1,
          updatedAt: 2_000,
        };
        for (const field of Object.keys(current)) {
          if (current[field] === null) delete current[field];
        }
        return current;
      },
      sendFailureImpl: async () => {
        notifications++;
      },
      deliverImpl: async (_update, { onAcceptanceFailure }) => {
        current = {
          status: "running",
          generation: 8,
          updatedAt: 2_000,
          ingressId: "reply-ingress",
          ingressAt: 2_000,
          statusMessageId: 81,
        };
        await onAcceptanceFailure({
          kind: "dispatch",
          status: 503,
          attempt: 1,
        });
        resetBeforeReturn = current.status === "idle";
        return false;
      },
    }),
  );

  assert.equal(result, "rejected");
  assert.equal(resetBeforeReturn, true);
  assert.equal(notifications, 1);
});

test("direct failure cleanup never clobbers a turn that acquired a session", async () => {
  let current: StatusRecord = {
    status: "idle",
    generation: 2,
    updatedAt: 900,
  };
  let casCalls = 0;
  let notifications = 0;
  const result = await routeMessageUpdate(
    routedUpdate,
    routeDeps({
      statusImpl: () => current,
      setStatusIfImpl: () => {
        casCalls++;
        return null;
      },
      sendFailureImpl: async () => {
        notifications++;
      },
      deliverImpl: async (_update, { onAcceptanceFailure }) => {
        current = {
          status: "running",
          generation: 3,
          updatedAt: 1_000,
          ingressId: "adopted-ingress",
          ingressAt: 1_000,
          sessionId: "live-session",
          turnId: "live-turn",
        };
        await onAcceptanceFailure({
          kind: "timeout",
          status: "timeout",
          attempt: 1,
        });
        return false;
      },
    }),
  );

  assert.equal(result, "rejected");
  assert.equal(casCalls, 0);
  assert.equal(current.sessionId, "live-session");
  assert.equal(notifications, 1);
});

test("callback_query delivery keeps the original option-free webhook path", async () => {
  const callbackUpdate = {
    update_id: 11,
    callback_query: {
      id: "callback-11",
      from: { id: 42, is_bot: false },
      message: routedUpdate.message,
      data: "iva_cancel",
    },
  };
  let statusReads = 0;
  const result = await routeMessageUpdate(
    callbackUpdate,
    routeDeps({
      statusImpl: () => {
        statusReads++;
        return null;
      },
      deliverImpl: async (update, options) => {
        assert.equal(update, callbackUpdate);
        assert.equal(options, undefined);
        return true;
      },
    }),
  );

  assert.equal(result, "delivered");
  assert.equal(statusReads, 0);
});

test("routeMessageUpdate reports enqueue failure without acknowledging", async () => {
  let acknowledged = 0;
  const result = await routeMessageUpdate(
    routedUpdate,
    routeDeps({
      runningImpl: () => true,
      enqueueImpl: async () => {
        throw new Error("disk full");
      },
      acknowledgeImpl: async () => {
        acknowledged++;
      },
    }),
  );

  assert.equal(result, "enqueue-failed");
  assert.equal(acknowledged, 0);
});

const reaperNow = 2_000_000;
// Токен намеренно оставлен namespaced: ровно так его писали версии до фикса #110, и жнец
// обязан лечить такие статусы — reset-роут клеит имя канала сам, а "telegram:telegram:1::"
// не находит владельца и молча отвечает no_active_session.
const staleStatus = {
  status: "running",
  generation: 7,
  updatedAt: reaperNow - 31_000,
  continuationToken: "telegram:1::",
  sessionId: "session-1",
  turnId: "turn-1",
  statusMessageId: 77,
};

function reaperDeps(
  statuses: ReaperStatus[],
  overrides: Partial<ReaperOptions> = {},
): ReaperOptions {
  return {
    listStatusesImpl: async () => statuses,
    setStatusIfImpl: () => ({ status: "idle" }),
    resetImpl: async () => {},
    sendImpl: async () => {},
    deleteMessageImpl: async () => {},
    now: () => reaperNow,
    inFlight: new Map(),
    staleMs: 30_000,
    trImpl: (_en, ru) => ru,
    logImpl: () => {},
    ...overrides,
  };
}

test("reapStaleRuns flips one stale run, resets Eve, notifies, and removes working status", async () => {
  const calls: Call[] = [];
  const reaped = await reapStaleRuns(
    reaperDeps([{ chatKey: "1:", status: staleStatus }], {
      setStatusIfImpl: (key, expected, patch) => {
        calls.push(["cas", key, expected, patch]);
        return { ...staleStatus, ...patch, generation: 8 };
      },
      resetImpl: async (key, token) => calls.push(["reset", key, token]),
      sendImpl: async (key, text) => calls.push(["send", key, text]),
      deleteMessageImpl: async (key, messageId) =>
        calls.push(["delete", key, messageId]),
    }),
  );

  assert.equal(reaped, 1);
  assert.deepEqual(calls[0].slice(0, 3), [
    "cas",
    "1:",
    { status: "running", generation: 7, updatedAt: reaperNow - 31_000 },
  ]);
  assert.equal((calls[0][3] as StatusRecord).status, "idle");
  assert.equal((calls[0][3] as StatusRecord).resetAt, reaperNow);
  assert.deepEqual(calls.slice(1), [
    // Сброс уходит channel-local, хотя в статусе лежит namespaced-токен.
    ["reset", "1:", "1::"],
    ["send", "1:", "Предыдущий ход оборвался - повтори запрос или /new"],
    ["delete", "1:", 77],
  ]);
});

test("reapStaleRuns leaves a fresh running record untouched", async () => {
  let sideEffects = 0;
  const reaped = await reapStaleRuns(
    reaperDeps(
      [
        {
          chatKey: "1:",
          status: { ...staleStatus, updatedAt: reaperNow - 30_000 },
        },
      ],
      {
        setStatusIfImpl: () => {
          sideEffects++;
          return { status: "idle" };
        },
      },
    ),
  );

  assert.equal(reaped, 0);
  assert.equal(sideEffects, 0);
});

test("reapStaleRuns leaves non-running statuses untouched", async () => {
  let sideEffects = 0;
  const reaped = await reapStaleRuns(
    reaperDeps(
      [
        { chatKey: "1:", status: { ...staleStatus, status: "idle" } },
        { chatKey: "2:", status: { ...staleStatus, status: "failed" } },
      ],
      {
        setStatusIfImpl: () => {
          sideEffects++;
          return { status: "idle" };
        },
      },
    ),
  );

  assert.equal(reaped, 0);
  assert.equal(sideEffects, 0);
});

test("reapStaleRuns stops after a CAS conflict", async () => {
  let reset = 0;
  let sent = 0;
  const reaped = await reapStaleRuns(
    reaperDeps([{ chatKey: "1:", status: staleStatus }], {
      setStatusIfImpl: () => null,
      resetImpl: async () => reset++,
      sendImpl: async () => sent++,
    }),
  );

  assert.equal(reaped, 0);
  assert.equal(reset, 0);
  assert.equal(sent, 0);
});

test("reapStaleRuns skips chats while their queue head is mid-drain", async () => {
  let sideEffects = 0;
  const reaped = await reapStaleRuns(
    reaperDeps([{ chatKey: "1:", status: staleStatus }], {
      inFlight: new Map([["1:", { state: "delivering" }]]),
      setStatusIfImpl: () => {
        sideEffects++;
        return { status: "idle" };
      },
    }),
  );

  assert.equal(reaped, 0);
  assert.equal(sideEffects, 0);
});

test("reapStaleRuns swallows and logs a notification failure", async () => {
  const logs: string[] = [];
  let deleted = 0;
  const reaped = await reapStaleRuns(
    reaperDeps([{ chatKey: "1:", status: staleStatus }], {
      sendImpl: async () => {
        throw new Error("Telegram unavailable");
      },
      deleteMessageImpl: async () => deleted++,
      logImpl: (...args) => logs.push(args.join(" ")),
    }),
  );

  assert.equal(reaped, 1);
  assert.equal(deleted, 1);
  assert.equal(logs.length, 1);
  assert.match(
    logs[0],
    /stale run notification failed for 1:: Telegram unavailable/,
  );
});

test("a fresh message is delivered after its stale status is reaped", async () => {
  let running = true;
  await reapStaleRuns(
    reaperDeps([{ chatKey: "1:", status: staleStatus }], {
      setStatusIfImpl: () => {
        running = false;
        return { status: "idle" };
      },
    }),
  );

  const result = await routeMessageUpdate(
    routedUpdate,
    routeDeps({
      runningImpl: () => running,
    }),
  );
  assert.equal(result, "delivered");
});

test("readCappedStream reads a small body under the cap", async () => {
  assert.equal(
    await readCappedStream(streamOf('{"installed":{}}'), 1024),
    '{"installed":{}}',
  );
});

test("readCappedStream: oversized body with NO metadata → null (hard cap mid-stream)", async () => {
  const chunk = "x".repeat(1000);
  assert.equal(
    await readCappedStream(streamOf(chunk, chunk, chunk), 2048),
    null,
  );
});

test("readCappedStream: exactly at the cap allowed, one over rejected; null body → null", async () => {
  assert.equal(await readCappedStream(streamOf("abcd"), 4), "abcd");
  assert.equal(await readCappedStream(streamOf("abcde"), 4), null);
  assert.equal(await readCappedStream(null, 1024), null);
});

test("file-capable secret: message is DELETED BEFORE the download, then content delivered", async () => {
  const r = recorder();
  const msg = {
    chat: { id: 1 },
    message_id: 42,
    document: { file_id: "F", file_size: 100 },
  };
  const pending = {
    flow: "menu",
    awaitText: { secret: true, file: true, kind: "gwsjson" },
  };
  const consumed = await handleAwaitNonText(msg, pending, r.io);
  assert.equal(consumed, true); // consumed → handleControl won't deliver it to eve
  assert.deepEqual(r.names(), ["delete", "download", "deliver"]);
  assert.ok(
    r.names().indexOf("delete") < r.names().indexOf("download"),
    "delete must precede download",
  );
});

test("failed deletion → the secret is NOT downloaded or delivered (still consumed)", async () => {
  const r = recorder('{"installed":{}}', { deleteOk: false });
  const msg = {
    chat: { id: 1 },
    message_id: 42,
    document: { file_id: "F", file_size: 100 },
  };
  const pending = {
    flow: "menu",
    awaitText: { secret: true, file: true, kind: "gwsjson" },
  };
  const consumed = await handleAwaitNonText(msg, pending, r.io);
  assert.equal(consumed, true); // never reaches eve
  assert.deepEqual(r.names(), ["delete"]); // deletion failed → no download, no deliver
});

test("over-size document is deleted and never downloaded", async () => {
  const r = recorder();
  const msg = {
    chat: { id: 1 },
    message_id: 9,
    document: { file_id: "F", file_size: 999_999 },
  };
  const pending = {
    flow: "menu",
    awaitText: { secret: true, file: true, kind: "gwsjson" },
  };
  await handleAwaitNonText(msg, pending, r.io);
  assert.deepEqual(r.names(), ["delete", "reply"]); // no download
});

test("secret prompt + non-file attachment (photo) → deleted with an ack, not delivered to eve", async () => {
  const r = recorder();
  const msg = { chat: { id: 1 }, message_id: 7 }; // no .document → a photo/sticker/etc
  const pending = { flow: "menu", awaitText: { secret: true, kind: "apikey" } };
  const consumed = await handleAwaitNonText(msg, pending, r.io);
  assert.equal(consumed, true);
  assert.deepEqual(r.names(), ["delete", "reply"]); // deleted + told how to send; never reaches eve
});

test("stale wizard callbacks are rejected by message and screen step", () => {
  const st: WizardState = { msgId: 42, step: "models" };
  assert.equal(isStaleWizard(st, 41), true);
  assert.equal(isStaleWizard(st, 42), false);
  assert.equal(isStaleWizard(null, 42), true);
  assert.equal(wizardActionAllowed(st, "m:0"), true);
  assert.equal(wizardActionAllowed(st, "eff:high"), false);
  assert.equal(wizardActionAllowed(st, "unknown"), false);
  assert.equal(
    selectWizardModel(
      { modelOptions: [{ id: "safe", reasoningLevels: [] }] },
      "",
    ),
    null,
  );
  assert.equal(
    selectWizardModel(
      { modelOptions: [{ id: "safe", reasoningLevels: [] }] },
      "00",
    ),
    null,
  );
  assert.equal(
    selectWizardModel(
      { modelOptions: [{ id: "safe", reasoningLevels: [] }] },
      "99",
    ),
    null,
  );
  assert.equal(wizardActionAllowed({ step: "model_error" }, "retry"), true);
  assert.equal(wizardActionAllowed({ step: "model_error" }, "back"), true);
});

test("model switch carries that model's levels; unknown effort never clears state", () => {
  const st = {
    model: "old",
    effort: "low",
    efforts: ["low"],
    modelOptions: [
      { id: "gpt-a", reasoningLevels: ["low", "medium"] },
      { id: "gpt-b", reasoningLevels: ["high", "max"] },
    ],
  };
  assert.deepEqual(selectWizardModel(st, "1"), st.modelOptions[1]);
  assert.equal(st.model, "gpt-b");
  assert.deepEqual(st.efforts, ["high", "max"]);
  assert.equal(selectWizardEffort(st, "bogus"), false);
  assert.equal(st.effort, "low");
  assert.equal(selectWizardEffort(st, "max"), true);
  assert.equal(st.effort, "max");
  assert.equal(selectWizardEffort(st, "unset"), true);
  assert.equal(st.effort, null);
});

test("stale current model stays display-only while a live current remains selectable", () => {
  const live = [
    { id: "new-a", reasoningLevels: ["low"] },
    { id: "current", reasoningLevels: ["high"] },
  ];
  assert.deepEqual(
    selectableWizardOptions(live, "retired").map((item) => item.id),
    ["new-a", "current"],
  );
  assert.deepEqual(
    selectableWizardOptions(live, "current").map((item) => item.id),
    ["current", "new-a"],
  );
});

test("Cancel during a rejected model fetch discards the stale error path", async () => {
  const st: WizardState = { chatId: 1, userId: "2" };
  let active: WizardState | null = st;
  let rejectFetch: (reason?: unknown) => void = () => undefined;
  const pending = runWizardRequest(
    st,
    () =>
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      }),
    (candidate) => active === candidate,
  );

  active = null; // Cancel removed this object from the flow slot while fetch was pending.
  rejectFetch(Object.assign(new Error("key rejected"), { auth: true }));
  assert.deepEqual(await pending, { stale: true });
});

test("/think catalog failure keeps the wizard and routes to Retry/Back error state", async () => {
  const st: WizardState = { step: "loading", removed: false };
  const failure = Object.assign(new Error("catalog offline"), {
    code: "catalog_unavailable",
  });

  const options = await resolveThinkCatalogLoad(
    st,
    { ok: false, error: failure },
    async (current, error) => {
      assert.equal(current, st);
      assert.equal(error, failure);
      current.step = "model_error";
      current.buttons = ["retry", "back"];
    },
  );

  assert.equal(options, null);
  assert.equal(st.removed, false);
  assert.equal(st.step, "model_error");
  assert.deepEqual(st.buttons, ["retry", "back"]);
});

test("catalog change before save preserves the old env", async () => {
  const writes: Array<Record<string, string | null>> = [];
  await assert.rejects(
    validateAndSaveWizard(
      {
        flow: "model",
        provider: "ollama",
        model: "retired",
        effort: "high",
        pendingKey: "new-secret",
      },
      {
        readEnv: async () => ({
          MODEL_PROVIDER: "codex",
          CODEX_MODEL: "old-model",
          OLLAMA_API_KEY: "old-secret",
        }),
        validate: async () => {
          throw Object.assign(new Error("retired"), {
            code: "model_unavailable",
          });
        },
        write: async (updates) => writes.push(updates),
      },
    ),
    /retired/,
  );
  assert.deepEqual(writes, []);
});

test("provider, model, effort and pending key persist in one atomic write", async () => {
  const validations: WizardState[] = [];
  const writes: Array<Record<string, string | null>> = [];
  await validateAndSaveWizard(
    {
      flow: "model",
      provider: "opencode",
      model: "live-model",
      effort: "medium",
      pendingKey: "new-secret",
    },
    {
      readEnv: async () => ({ MODEL_PROVIDER: "ollama" }),
      validate: async (selection) => {
        validations.push(selection);
        return { id: selection.model, reasoningLevels: ["medium"] };
      },
      write: async (updates) => writes.push(updates),
    },
  );
  assert.equal(validations[0].key, "new-secret");
  assert.deepEqual(writes, [
    {
      THINKING_EFFORT: "medium",
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "live-model",
      OPENCODE_API_KEY: "new-secret",
    },
  ]);
});
