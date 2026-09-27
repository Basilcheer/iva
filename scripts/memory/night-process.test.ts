// Настоящий процесс ночи (scripts/memory/night.ts) против двойника модели: локальный
// OpenAI-совместимый сервер отвечает вызовом инструмента submit и считает запросы. Vault
// под git во временной папке. Утверждаются файлы vault, история git, stderr и код выхода.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const NIGHT = join(ROOT, "scripts/memory/night.ts");
const HOOKS = join(ROOT, "scripts/lib/ts-esm-hooks.ts");
const DATE = "2026-09-26";
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(
  new Date(),
);

class ModelDouble {
  readonly prompts: string[] = [];
  replies: unknown[] = [];
  private readonly held = new Map<
    number,
    { entered: () => void; gate: Promise<void> }
  >();
  readonly server = createServer(
    (request, response) => void this.handle(request, response),
  );

  hold(call: number) {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((accept) => (entered = accept));
    const gate = new Promise<void>((accept) => (release = accept));
    this.held.set(call, { entered, gate });
    return { reached, release };
  }

  async start(t: TestContext): Promise<string> {
    await new Promise<void>((accept) =>
      this.server.listen(0, "127.0.0.1", accept),
    );
    t.after(async () => {
      this.server.closeAllConnections();
      await new Promise((accept) => this.server.close(accept));
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const messages = (
      JSON.parse(body) as { messages: Array<{ content: unknown }> }
    ).messages;
    this.prompts.push(JSON.stringify(messages.at(-1)?.content));
    const held = this.held.get(this.prompts.length);
    if (held) {
      held.entered();
      await held.gate;
    }
    // Сценарий ответа: { status } — ошибка HTTP, { text } — текст без JSON,
    // { usage, value } — свой расход (null — без usage), иначе — сам JSON ответа.
    const reply = this.replies.shift() as Record<string, unknown> | undefined;
    const send = (status: number, value: unknown) =>
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (reply === undefined)
      return send(500, { error: { message: "unexpected model call" } });
    if (typeof reply.status === "number")
      return send(reply.status, {
        error: { message: `double ${reply.status}` },
      });
    const own = "usage" in reply;
    const usage = own ? (reply.usage as number | null) : 100;
    const value = own ? reply.value : reply;
    const text = typeof reply.text === "string" ? reply.text : null;
    // Модель отвечает текстом: JSON в markdown-ограде, как делают настоящие модели.
    const content =
      text ?? `Ответ:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
    const message = { role: "assistant", content };
    send(200, {
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "double",
      choices: [{ index: 0, message, finish_reason: "stop" }],
      ...(usage === null
        ? {}
        : {
            usage: {
              prompt_tokens: usage,
              completion_tokens: 10,
              total_tokens: usage + 10,
            },
          }),
    });
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface Fixture {
  readonly vault: string;
  readonly data: string;
  readonly model: ModelDouble;
  baseUrl: string;
}

async function fixture(t: TestContext, core = true): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "iva-night-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const data = join(root, "data");
  mkdirSync(join(vault, "daily"), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(data, "settings.json"), "{}\n");
  if (core)
    writeFileSync(
      join(vault, "CORE.md"),
      "# CORE\n\n## Пользователь\n\n## Предпочтения\n\n## Активные цели\n",
    );
  writeFileSync(
    join(vault, "schema.json"),
    JSON.stringify({ node_types: { project: { status: ["active", "done"] } } }),
  );
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "night@example.invalid");
  git(vault, "config", "user.name", "Night");
  commit(vault, "initial");
  const model = new ModelDouble();
  return { vault, data, model, baseUrl: await model.start(t) };
}

function commit(vault: string, message = "fixture"): void {
  git(vault, "add", "-A");
  git(vault, "commit", "-qm", message, "--allow-empty");
}

function spawnNight(
  fx: Fixture,
  date: string | null = DATE,
  env: Record<string, string> = {},
) {
  const args = ["--import", HOOKS, NIGHT, ...(date ? [date] : [])];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ASSISTANT_VAULT_DIR: fx.vault,
      ASSISTANT_DATA_DIR: fx.data,
      ASSISTANT_TIMEZONE: "UTC",
      MODEL_PROVIDER: "custom",
      CUSTOM_BASE_URL: fx.baseUrl,
      CUSTOM_API_KEY: "test",
      CUSTOM_MODEL: "double",
      IVA_JOB_STOP_AT: String(Date.now() + 60_000),
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_DIGEST_CHAT_ID: "",
      TELEGRAM_ALLOWED_USER_IDS: "",
      IVA_MEMORY_LOCK_HELD: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child
    .stderr!.setEncoding("utf8")
    .on("data", (chunk: string) => (stderr += chunk));
  const result = new Promise<{ code: number | null; stderr: string }>(
    (accept) => child.once("close", (code) => accept({ code, stderr })),
  );
  return { child, result };
}

const night = (
  fx: Fixture,
  date?: string | null,
  env?: Record<string, string>,
) => spawnNight(fx, date, env).result;

function A(parts: Record<string, unknown> = {}) {
  return {
    gist: "Запущен проект Аврора",
    topics: ["проекты"],
    points: [{ text: "Старт Авроры", src: "e1" }],
    new_cards: [],
    facts: [],
    aliases: [],
    links: [],
    core: [],
    ...parts,
  };
}
const newAurora = {
  name: "Аврора",
  type: "project",
  description: "Новый проект",
};
const B = (...cards: Array<Record<string, unknown>>) => ({
  cards: cards.map((card) => ({
    truth: null,
    description: null,
    status: null,
    ...card,
  })),
});

function day(fx: Fixture, text: string, date = DATE): string {
  const file = join(fx.vault, "daily", `${date}.md`);
  writeFileSync(file, text);
  commit(fx.vault, `day ${date}`);
  return file;
}

function card(fx: Fixture, path: string, lines: string[]): string {
  const file = join(fx.vault, `${path}.md`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  commit(fx.vault, `card ${path}`);
  return file;
}

const read = (file: string) => readFileSync(file, "utf8");
const summary = (fx: Fixture, date = DATE) =>
  join(fx.vault, "summaries/daily", `${date}.md`);
const logRows = (text: string) =>
  text.split("\n").filter((line) => /^- \d{4}-\d{2}-\d{2}: /u.test(line));
const aurora = [
  "---",
  'type: "project"',
  'description: "Проект"',
  'status: "active"',
  "---",
  "# Аврора",
  "",
  "Первая строка правды",
  "Вторая строка правды",
  "Третья строка правды",
  "",
  "## Log",
  "",
  "## Related",
  "",
  "## History",
  "",
];

void test("обычный день: A и B, Card, выжимка, отметка, коммиты; повтор ночи ничего не зовёт и не меняет", async (t) => {
  const fx = await fixture(t);
  const raw =
    "## 10:00 [text]\nЗапустил проект Аврора\n\n## 10:05 [iva]\nОтличный старт\n";
  const file = day(fx, raw);
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
      ],
    }),
    B({ card: "cards/projects/аврора", truth: "Проект запуска" }),
  ];
  const first = await night(fx);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.equal(
    read(file),
    `${raw}\n<!-- processed: memory-night ${DATE} -->\n`,
  );
  const text = read(join(fx.vault, "cards/projects/аврора.md"));
  assert.deepEqual(logRows(text), [
    `- ${DATE}: Проект запущен · [[daily/${DATE}]] 10:00`,
  ]);
  assert.match(text, /# Аврора\n\nПроект запуска\n\n## Log/u);
  assert.match(
    read(summary(fx)),
    /source: "night"[\s\S]*body_hash: "[0-9a-f]{64}"/u,
  );
  assert.match(read(summary(fx)), /- \[\[cards\/projects\/аврора\]\]/u);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
  const head = git(fx.vault, "rev-parse", "HEAD");
  const again = await night(fx, null);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
});

void test("B заменяет правду целиком: сменённая средняя строка уходит в History, порядок цел (ДЕФ-1, ДЕФ-18)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nВторую строку меняю\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Строка меняется",
          src: "e1",
          quote: "Вторую строку меняю",
        },
      ],
    }),
    B({
      card: "cards/projects/аврора",
      truth: "Первая строка правды\nНовая вторая\nТретья строка правды",
    }),
  ];
  assert.equal((await night(fx)).code, 0);
  const text = read(file);
  assert.match(
    text,
    /# Аврора\n\nПервая строка правды\nНовая вторая\nТретья строка правды\n\n## Log/u,
  );
  assert.match(
    text,
    new RegExp(
      `## History\\n\\n- ${DATE}: Вторая строка правды \\(сменено: \\[\\[daily/${DATE}\\]\\]\\)`,
      "u",
    ),
  );
  assert.match(text, new RegExp(`truth_date: "${DATE}"`, "u"));
});

void test("поздний хвост: A только по новым репликам, Log без повторов, дубля Card нет (M2, ДЕФ-2)", async (t) => {
  const fx = await fixture(t);
  const file = day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  assert.equal((await night(fx)).code, 0);
  appendFileSync(file, "\n## 11:00 [text]\nСрок Авроры пятница\n");
  commit(fx.vault);
  fx.model.replies = [
    A({
      gist: "Аврора и срок",
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Срок пятница",
          src: ["e2"],
          quote: "Срок Авроры пятница",
        },
        {
          card: "cards/projects/аврора",
          text: "Проект запущен",
          src: "e2",
          quote: "Срок Авроры",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  const tail = await night(fx);
  assert.equal(tail.code, 0, tail.stderr);
  assert.equal(fx.model.prompts.length, 4);
  assert.doesNotMatch(fx.model.prompts[2], /Запустил проект/u);
  assert.match(fx.model.prompts[2], /Запущен проект Аврора/u);
  assert.match(fx.model.prompts[2], /cards\/projects\/аврора/u);
  const text = read(join(fx.vault, "cards/projects/аврора.md"));
  assert.equal(logRows(text).length, 2);
  assert.deepEqual(
    execFileSync("ls", [join(fx.vault, "cards/projects")], {
      encoding: "utf8",
    }).trim(),
    "аврора.md",
  );
  assert.match(read(summary(fx)), /description: "Аврора и срок"/u);
  assert.equal(read(file).match(/processed: memory-night/gu)?.length, 2);
  const unchanged = git(fx.vault, "rev-parse", "HEAD");
  writeFileSync(file, read(file).replace("Запустил", "Начал"));
  commit(fx.vault);
  const edited = await night(fx, null);
  assert.equal(fx.model.prompts.length, 4);
  assert.match(edited.stderr, /изменён после разбора/u);
  assert.notEqual(unchanged, "");
});

void test("выключатель: ничего не читается и не зовётся", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ memory: { night: "off" } }),
  );
  chmodSync(fx.vault, 0o000);
  const result = await night(fx);
  chmodSync(fx.vault, 0o755);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /выключено/u);
  assert.equal(fx.model.prompts.length, 0);
});

void test("ответ не по форме: один повтор с текстом ошибки, потом no-report; ответ без submit тоже повторяется", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  fx.model.replies = [
    { text: "Не понял задачу" },
    { text: "Вот ответ словами" },
  ];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /Ошибка прошлого ответа/u);
  assert.equal(existsSync(summary(fx)), false);
  assert.match(read(join(fx.data, "rollup-attempts.json")), /no-report/u);
  fx.model.replies = [{ text: "без инструмента" }, A(), B()];
  const retried = await night(fx);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(existsSync(summary(fx)), true);
});

void test("негодный факт отбрасывается со строкой в Job, остальной ответ применяется", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
        {
          card: "Несуществующая",
          text: "Лишнее",
          src: "e1",
          quote: "Запустил",
        },
        { card: "Аврора", text: "Из воздуха", src: "e9", quote: "Запустил" },
        { card: "Аврора", text: "Выдумка", src: "e1", quote: "этого не было" },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /отброшено.*Несуществующая/u);
  assert.match(result.stderr, /отброшено.*e9/u);
  assert.match(result.stderr, /отброшено.*этого не было/u);
  assert.deepEqual(
    logRows(read(join(fx.vault, "cards/projects/аврора.md"))).length,
    1,
  );
});

void test("сеть 429: один вызов, без попытки дня, день в очереди", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  fx.model.replies = [{ status: 429 }];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
  fx.model.replies = [A(), B()];
  assert.equal((await night(fx)).code, 0);
});

void test("kill -9 на B: повтор без второго A и без дубля Card, даже если отметка применения не успела", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
      ],
    }),
  ];
  const held = fx.model.hold(2);
  const run = spawnNight(fx);
  await held.reached;
  run.child.kill("SIGKILL");
  await run.result;
  held.release();
  await new Promise((accept) => setTimeout(accept, 100));
  const cache = join(fx.data, "memory/night", `${DATE}.json`);
  const state = JSON.parse(read(cache)) as { pass: Record<string, unknown> };
  delete state.pass.applied;
  delete state.pass.truth;
  writeFileSync(cache, JSON.stringify(state));
  fx.model.replies = [B({ card: "cards/projects/аврора" })];
  const again = await night(fx);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fx.model.prompts.length, 3);
  assert.equal(
    execFileSync("ls", [join(fx.vault, "cards/projects")], {
      encoding: "utf8",
    }).trim(),
    "аврора.md",
  );
  assert.equal(
    logRows(read(join(fx.vault, "cards/projects/аврора.md"))).length,
    1,
  );
});

void test("правка человека во время B побеждает, день закрыт, B по Card следующей ночью (ДЕФ-3)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора", truth: "Ночная правда" }),
  ];
  const held = fx.model.hold(2);
  const run = spawnNight(fx);
  await held.reached;
  writeFileSync(
    file,
    read(file).replace("Первая строка правды", "Правда владельца"),
  );
  held.release();
  const first = await run.result;
  assert.equal(first.code, 0, first.stderr);
  assert.match(read(file), /Правда владельца/u);
  assert.doesNotMatch(read(file), /Ночная правда/u);
  assert.match(read(file), new RegExp(`truth_pending: "${DATE}"`, "u"));
  assert.match(first.stderr, /изменён человеком/u);
  assert.equal(existsSync(summary(fx)), true);
  day(fx, "## 09:00 [text]\nПросто день\n", "2026-09-27");
  fx.model.replies = [
    A({ facts: [] }),
    B({
      card: "cards/projects/аврора",
      truth: "Правда владельца\nКурс сменён",
    }),
  ];
  const second = await night(fx, "2026-09-27");
  assert.equal(second.code, 0, second.stderr);
  assert.match(fx.model.prompts[3], /Курс сменён/u);
  assert.doesNotMatch(read(file), /truth_pending/u);
});

void test("занятое имя новой Card: отдельная Card «Имя (D)» и Alert, исходная байт в байт", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора\n");
  const file = card(fx, "cards/notes/аврора", [
    "---",
    'type: "note"',
    'aliases: ["Аврора"]',
    "---",
    "# Аврора",
    "",
    "## Log",
    "",
  ]);
  const before = read(file);
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        { card: "Аврора", text: "Новый проект", src: "e1", quote: "Аврора" },
      ],
    }),
    B({ card: `cards/projects/аврора-${DATE}` }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(file), before);
  assert.match(
    read(join(fx.vault, `cards/projects/аврора-${DATE}.md`)),
    new RegExp(`# Аврора \\(${DATE}\\)`, "u"),
  );
  assert.match(result.stderr, /Похоже на дубль: Аврора/u);
});

void test("открытый фенс и чужой файл на месте новой Card: факты в pending, файлы целы; починка дописывает без модели (ДЕФ-4)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора и Борис\n");
  const fenced = card(fx, "cards/projects/аврора", [
    "---",
    'type: "project"',
    "---",
    "# Аврора",
    "",
    "## Log",
    "",
    "```",
    "открыто",
    "",
  ]);
  const foreign = card(fx, "cards/contacts/борис", [
    "---",
    'description: "битая кавычка',
    "---",
    "# Борис",
    "",
    "Текст владельца",
    "",
  ]);
  const [fencedBefore, foreignBefore] = [read(fenced), read(foreign)];
  fx.model.replies = [
    A({
      new_cards: [{ name: "Борис", type: "contact", description: "Коллега" }],
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Аврора идёт",
          src: "e1",
          quote: "Аврора",
        },
        { card: "Борис", text: "Борис в команде", src: "e1", quote: "Борис" },
      ],
    }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(fenced), fencedBefore);
  assert.equal(read(foreign), foreignBefore);
  assert.match(result.stderr, /Поправь Card cards\/projects\/аврора/u);
  writeFileSync(fenced, fencedBefore.replace("открыто\n", "открыто\n```\n"));
  commit(fx.vault);
  const fixed = await night(fx, null);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(logRows(read(fenced)).length, 1);
});

void test("предел ночи: большой расход на A — B не начат, попытка cut, код 1; без usage следующий вызов закрыт", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора\n");
  card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    {
      usage: 299_990,
      value: A({
        facts: [
          {
            card: "cards/projects/аврора",
            text: "Факт",
            src: "e1",
            quote: "Аврора",
          },
        ],
      }),
    },
  ];
  const cut = await night(fx);
  assert.equal(cut.code, 1);
  assert.equal(fx.model.prompts.length, 1);
  assert.match(cut.stderr, /обрез пределом ночи/u);
  assert.match(read(join(fx.data, "rollup-attempts.json")), /"cut"/u);
  assert.equal(existsSync(summary(fx)), false);
  fx.model.replies = [
    { usage: null, value: B({ card: "cards/projects/аврора" }) },
  ];
  const unknown = await night(fx);
  assert.equal(unknown.code, 0, unknown.stderr);
  assert.match(unknown.stderr, /usage unknown/u);
});

void test("отказ коммита: день не готов; следующая ночь коммитит без вызова модели", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  const hook = join(fx.vault, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  fx.model.replies = [A(), B()];
  const failed = await night(fx);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /не закоммичен/u);
  rmSync(hook);
  const resumed = await night(fx, null);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
  assert.equal(existsSync(summary(fx)), true);
});

void test("первая ночь без CORE: C зовётся, CORE создан, строка сразу под заголовком раздела (ДЕФ-6, ДЕФ-8)", async (t) => {
  const fx = await fixture(t, false);
  day(fx, "## 10:00 [text]\nКофе после четырёх не пью\n");
  fx.model.replies = [
    A({ core: [{ text: "Не пьёт кофе после 16:00", src: "e1" }] }),
    {
      sections: [
        { section: "Предпочтения", text: "- Не пьёт кофе после 16:00" },
      ],
    },
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    read(join(fx.vault, "CORE.md")),
    /## Предпочтения\n\n- Не пьёт кофе после 16:00\n\n## Активные цели/u,
  );
  assert.match(
    read(join(fx.vault, "CORE.md")),
    new RegExp(`Последний день: summaries/daily/${DATE}`, "u"),
  );
});

void test("CORE над лимитом: повтор с «освободи», отказ — кандидат ждёт следующей ночи, не exit 1 (ДЕФ-7)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЛюблю чай\n");
  const long = `- ${"x".repeat(4000)}`;
  fx.model.replies = [
    A({ core: [{ text: "Любит чай", src: "e1" }] }),
    { sections: [{ section: "Предпочтения", text: long }] },
    { sections: [{ section: "Предпочтения", text: long }] },
  ];
  const first = await night(fx);
  assert.equal(first.code, 0, first.stderr);
  assert.match(fx.model.prompts[2], /освободи \d+ знаков/u);
  assert.match(first.stderr, /кандидаты ждут/u);
  assert.doesNotMatch(read(join(fx.vault, "CORE.md")), /xxxx/u);
  fx.model.replies = [
    { sections: [{ section: "Предпочтения", text: "- Любит чай" }] },
  ];
  assert.equal((await night(fx, null)).code, 0);
  assert.match(fx.model.prompts[3], /Любит чай/u);
  assert.match(read(join(fx.vault, "CORE.md")), /- Любит чай/u);
});

void test("догон: из четырёх дней ночь берёт три старых по порядку", async (t) => {
  const fx = await fixture(t);
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"];
  for (const date of dates) day(fx, `## 10:00 [text]\nФакт ${date}\n`, date);
  fx.model.replies = dates.slice(0, 3).flatMap((date) => [A({ gist: date })]);
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  dates
    .slice(0, 3)
    .forEach((date, index) =>
      assert.match(fx.model.prompts[index], new RegExp(date, "u")),
    );
  assert.equal(existsSync(summary(fx, dates[3])), false);
});

void test("день по частям: A на каждую часть, вторая видит выжимку первой, одна выжимка дня", async (t) => {
  const fx = await fixture(t);
  day(
    fx,
    `## 10:00 [text]\n${"а".repeat(30_000)}\n\n## 11:00 [text]\n${"б".repeat(30_000)}\n`,
  );
  fx.model.replies = [
    A({ gist: "первая часть" }),
    A({ gist: "весь день", points: [{ text: "вторая", src: "e2" }] }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /первая часть/u);
  assert.match(
    read(summary(fx)),
    /description: "весь день"[\s\S]*- вторая · \[\[daily\/2026-09-26\]\] 11:00/u,
  );
});

void test("граница перехода и ручная правка: старая выжимка без body_hash и правленая выжимка не трогаются (ДЕФ-5, ДЕФ-12)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nСтарый день\n", "2020-02-10");
  day(
    fx,
    "## 10:00 [text]\nЕщё день\n\n## 11:00 [text]\nХвост после правки\n",
    "2020-02-11",
  );
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  const legacy =
    '---\ntype: "daily-summary"\ndescription: "старая ночь"\n---\n# 2020-02-10\n';
  writeFileSync(summary(fx, "2020-02-10"), legacy);
  writeFileSync(
    summary(fx, "2020-02-11"),
    `---\nbody_hash: "${"0".repeat(64)}"\n---\n# Правка владельца\n`,
  );
  commit(fx.vault);
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 0);
  assert.equal(read(summary(fx, "2020-02-10")), legacy);
  assert.match(read(summary(fx, "2020-02-11")), /Правка владельца/u);
  assert.match(result.stderr, /выжимка 2020-02-11 изменена вручную/u);
});

void test("iva jobs skip закрывает день отметкой в сыром дне", async (t) => {
  const fx = await fixture(t);
  day(
    fx,
    "## 10:00 [text]\nФакт\n\n<!-- processed: skipped by owner 2026-09-27T00:00:00Z -->\n",
  );
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 0);
});

void test("кэш не пишется: вызова нет, код 1 (ДЕФ-16)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  mkdirSync(join(fx.data, "memory"), { recursive: true });
  writeFileSync(join(fx.data, "memory/night"), "not a directory");
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 0);
});

void test("реплика, пришедшая во время ручной ночи, разбирается следующей ночью (ДЕФ-13)", async (t) => {
  const fx = await fixture(t);
  const file = day(fx, "## 10:00 [text]\nПервая\n");
  fx.model.replies = [A()];
  const held = fx.model.hold(1);
  const run = spawnNight(fx);
  await held.reached;
  appendFileSync(file, "\n## 10:30 [text]\nПришла во время ночи\n");
  held.release();
  assert.equal((await run.result).code, 0);
  fx.model.replies = [A({ points: [{ text: "поздняя", src: "e2" }] })];
  const next = await night(fx, null);
  assert.equal(next.code, 0, next.stderr);
  assert.match(fx.model.prompts[1], /Пришла во время ночи/u);
});

void test("CLI отвергает несуществующую дату (ДЕФ-19)", async (t) => {
  const fx = await fixture(t);
  const result = await night(fx, "2026-02-30");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage/u);
});

void test("нет сырого дня за вчера при ходах в usage.jsonl — Alert о сбое транскрипта (ДЕФ-17)", async (t) => {
  const fx = await fixture(t);
  const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  writeFileSync(
    join(fx.data, "usage.jsonl"),
    `${JSON.stringify({ ts: `${yesterday}T10:00:00.000Z`, source: "chat" })}\n`,
  );
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /memory-night alert night-transcript/u);
});

void test("неделя из готовых дней собирается одним вызовом; неготовый день держит период; сбой P — выжимка без модели", async (t) => {
  const fx = await fixture(t);
  const monday = new Date(Date.parse(`${TODAY}T00:00:00Z`));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
  const days = Array.from({ length: 7 }, (_, index) =>
    new Date(monday.getTime() + index * 86_400_000).toISOString().slice(0, 10),
  );
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  for (const date of days.slice(0, 6))
    writeFileSync(
      summary(fx, date),
      `---\ndescription: "день ${date}"\n---\n# ${date}\n`,
    );
  day(fx, "## 10:00 [text]\nПоследний день недели\n", days[6]);
  fx.model.replies = [
    A({ gist: "последний" }),
    { text: "неделя" },
    { text: "неделя" },
  ];
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(fx.model.prompts[0], /Последний день недели/u);
  const weekly = execFileSync("ls", [join(fx.vault, "weekly")], {
    encoding: "utf8",
  }).trim();
  assert.match(
    read(join(fx.vault, "weekly", weekly)),
    /mode: "fallback"[\s\S]*\[\[summaries\/daily\//u,
  );
  assert.match(result.stderr, /night-fallback/u);
});

void test("связь пишется в Related обеих Card; связь с неизвестной Card отброшена", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАнна и Борис взяли Аврору\n");
  const contact = (name: string) => [
    "---",
    'type: "contact"',
    "---",
    `# ${name}`,
    "",
    "## Log",
    "",
    "## Related",
    "",
  ];
  const anna = card(fx, "cards/contacts/анна", contact("Анна"));
  const boris = card(fx, "cards/contacts/борис", contact("Борис"));
  const quote = "Анна и Борис взяли Аврору";
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/contacts/анна",
          text: "Анна в Авроре",
          src: "e1",
          quote,
        },
        {
          card: "cards/contacts/борис",
          text: "Борис в Авроре",
          src: "e1",
          quote,
        },
      ],
      links: [
        { a: "cards/contacts/анна", b: "cards/contacts/борис", src: "e1" },
        { a: "cards/contacts/анна", b: "Никто", src: "e1" },
      ],
    }),
    B({ card: "cards/contacts/анна" }, { card: "cards/contacts/борис" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(read(anna), /## Related\n\n- \[\[cards\/contacts\/борис\]\]/u);
  assert.match(read(boris), /## Related\n\n- \[\[cards\/contacts\/анна\]\]/u);
  assert.match(result.stderr, /отброшено: .*Никто/u);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});
