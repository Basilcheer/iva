import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";

type Button = { text: string; callback_data: string };
type Rows = Button[][];

type InterviewState = {
  i: number;
  qa: Array<{ q: string; a: string }>;
  chat: Record<string, unknown> | null;
  from: Record<string, unknown> | null;
  threadId: number | null;
};

type MenuState = {
  chatId: number;
  userId: string;
  data: { iv?: InterviewState; [key: string]: unknown };
  awaitText: {
    kind: string;
    secret: boolean;
    data: Record<string, unknown>;
  } | null;
  [key: string]: unknown;
};

type Delivery = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    chat: Record<string, unknown>;
    from: Record<string, unknown>;
    text: string;
    message_thread_id?: number;
  };
};

type MenuContext = {
  deps: {
    deliver: (update: Delivery) => Promise<void>;
    log?: (...parts: unknown[]) => void;
  };
  getLang: () => "en" | "ru";
  tr: (en: string, ru: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
  flows: {
    screen: (state: MenuState, text: string, rows: Rows) => Promise<void>;
  };
  show: (state: MenuState, screen: string) => Promise<void>;
};

type CoreScreen = {
  parent: string;
  render: (
    state: MenuState,
    context: MenuContext,
  ) => Promise<{ text: string; rows: Rows }>;
  on: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => Promise<void>;
  texts: {
    interview: (
      text: unknown,
      message: {
        chat: Record<string, unknown>;
        from: Record<string, unknown>;
        message_thread_id?: number;
      },
      state: MenuState,
      context: MenuContext,
    ) => Promise<void>;
  };
};

type RunStatus = {
  chatKeyOf: (chatId: number, threadId: number | null) => string;
  setChatStatus: (chatKey: string, patch: Record<string, unknown>) => unknown;
};

const statusDir = mkdtempSync(join(tmpdir(), "iva-menu-core-status-"));
const previousDataDir = process.env.ASSISTANT_DATA_DIR;
process.env.ASSISTANT_DATA_DIR = statusDir;

const coreModulePath: string = "./core.ts";
const { default: core } = (await import(coreModulePath)) as {
  default: CoreScreen;
};
const runStatus = (await import("#lib/run-status.mjs")) as RunStatus;

after(() => {
  if (previousDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
  else process.env.ASSISTANT_DATA_DIR = previousDataDir;
  rmSync(statusDir, { recursive: true, force: true });
});

function useVault(t: TestContext): string {
  const vault = mkdtempSync(join(tmpdir(), "iva-menu-core-vault-"));
  const previousVault = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = vault;
  t.after(() => {
    if (previousVault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = previousVault;
    rmSync(vault, { recursive: true, force: true });
  });
  return vault;
}

function makeState(overrides: Partial<MenuState> = {}): MenuState {
  return {
    chatId: 44,
    userId: "77",
    data: {},
    awaitText: null,
    ...overrides,
  };
}

function makeContext(lang: "en" | "ru" = "ru") {
  const screens: Array<{ text: string; rows: Rows }> = [];
  const deliveries: Delivery[] = [];
  const shown: string[] = [];
  const context: MenuContext = {
    deps: {
      deliver: (update) => {
        deliveries.push(update);
        return Promise.resolve();
      },
      log: () => {},
    },
    getLang: () => lang,
    tr: (en, ru) => (lang === "ru" ? ru : en),
    btn: (text, callbackData) => ({ text, callback_data: callbackData }),
    backRow: (screen) => [
      { text: "‹ Назад", callback_data: `iva_menu:${screen}:o` },
    ],
    flows: {
      screen: (_state, text, rows) => {
        screens.push({ text, rows });
        return Promise.resolve();
      },
    },
    show: (_state, screen) => {
      shown.push(screen);
      return Promise.resolve();
    },
  };
  return { context, screens, deliveries, shown };
}

void test("core render handles an empty vault and trims an oversized CORE excerpt", async (t) => {
  const vault = useVault(t);
  const { context } = makeContext();
  const state = makeState();

  const empty = await core.render(state, context);
  assert.equal(core.parent, "r");
  assert.match(empty.text, /Ядро памяти пусто/);
  assert.deepEqual(empty.rows[0][0], {
    text: "Пройти интервью",
    callback_data: "iva_menu:core:go",
  });

  const excerpt = `${"а".repeat(399)}  ${"б".repeat(20)}`;
  writeFileSync(join(vault, "CORE.md"), `\n${excerpt}\n`, "utf8");
  const populated = await core.render(state, context);

  assert.ok(populated.text.includes("Текущее ядро:"));
  assert.ok(populated.text.includes(`${"а".repeat(399)}…`));
  assert.equal(populated.text.includes("б"), false);
});

void test("core interview stores the real reply identity and delivers a synthetic threaded distillation update", async (t) => {
  const vault = useVault(t);
  const { context, deliveries, screens } = makeContext();
  const state = makeState();
  const sourceMessage = {
    chat: { id: 44, type: "supergroup", title: "Family" },
    from: { id: 77, is_bot: false, first_name: "Сергей" },
    message_thread_id: 9,
  };

  await core.on("go", [], state, context);
  assert.deepEqual(state.awaitText, {
    kind: "interview",
    secret: false,
    data: {},
  });
  assert.match(screens.at(-1)?.text ?? "", /Как к тебе обращаться/);

  await core.texts.interview(
    "  Сергей, на ты  ",
    sourceMessage,
    state,
    context,
  );
  for (let index = 1; index < 6; index += 1)
    await core.on("skip", [], state, context);

  assert.equal(state.awaitText, null);
  assert.equal(deliveries.length, 1);
  const [delivery] = deliveries;
  assert.equal(delivery.update_id, 0);
  assert.deepEqual(delivery.message.chat, sourceMessage.chat);
  assert.deepEqual(delivery.message.from, sourceMessage.from);
  assert.equal(delivery.message.message_thread_id, 9);
  assert.match(delivery.message.text, /\[Настройка core memory\]/);
  assert.match(delivery.message.text, /Сергей, на ты/);
  assert.match(screens.at(-1)?.text ?? "", /Передал иве/);

  const archive = readFileSync(join(vault, "core-interview.md"), "utf8");
  assert.match(archive, /Сергей, на ты/);
  assert.match(archive, /—/);
});

void test("core saves the interview but never delivers while the same threaded chat is running", async (t) => {
  const vault = useVault(t);
  const { context, deliveries, screens } = makeContext();
  const state = makeState({
    chatId: 88,
    data: {
      iv: {
        i: 1,
        qa: [{ q: "Как обращаться?", a: "Сергей" }],
        chat: { id: 88, type: "supergroup" },
        from: { id: 77, is_bot: false },
        threadId: 12,
      },
    },
  });
  const key = runStatus.chatKeyOf(88, 12);
  runStatus.setChatStatus(key, { status: "running" });
  t.after(() => {
    runStatus.setChatStatus(key, { status: "idle" });
  });

  await core.on("fin", [], state, context);

  assert.equal(deliveries.length, 0);
  assert.equal(state.awaitText, null);
  assert.match(screens.at(-1)?.text ?? "", /сейчас занята/);
  assert.match(
    readFileSync(join(vault, "core-interview.md"), "utf8"),
    /Сергей/,
  );
});

void test("core keeps direct legacy error.message behavior for injectable delivery rejections", async (t) => {
  useVault(t);
  const { context } = makeContext();
  const logged: unknown[][] = [];
  context.deps.log = (...parts: unknown[]) => {
    logged.push(parts);
  };
  const interview = (): InterviewState => ({
    i: 0,
    qa: [],
    chat: null,
    from: null,
    threadId: null,
  });

  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- characterizes legacy non-Error rejection semantics.
  context.deps.deliver = () => Promise.reject("primitive delivery failure");
  await core.on("fin", [], makeState({ data: { iv: interview() } }), context);
  assert.deepEqual(logged, [["core deliver error:", undefined]]);

  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- characterizes legacy non-Error rejection semantics.
  context.deps.deliver = () => Promise.reject(null);
  await assert.rejects(
    core.on("fin", [], makeState({ data: { iv: interview() } }), context),
    TypeError,
  );
});
