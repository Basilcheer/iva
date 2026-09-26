/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setLastDayPointer } from "#lib/core-clamp.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const ROLLUP = join(ROOT, "scripts/memory/rollup.ts");
const SESSION_NAME = "rollup-session-monthly.json";

interface RecordedRequest {
  /** Момент приёма запроса сервером. */
  readonly at: number;
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
}

interface RollupRun {
  readonly code: number | null;
  /** Момент выхода процесса: остановка хода обязана случиться раньше. */
  readonly exitAt: number;
  /** Сигнал, которым процесс убит по умолчанию; null — вышел сам. */
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * own — ход с отчётом; hang — ход идёт и не кончается; no-report — ход кончился без
 * отчёта; cut — ход идёт за предел шагов, cancel гасит его; turn-failed — модель уронила
 * ход; session-failed — сессия упала (исключение хука eve); stream-breaks — поток хода
 * рвётся на повторном GET кодом 400 (клиент eve его не повторяет).
 */
type FakeMode =
  | "own"
  | "hang"
  | "no-report"
  | "cut"
  | "turn-failed"
  | "session-failed"
  | "stream-breaks";

function event(type: string, data?: Record<string, unknown>): object {
  return {
    ...(data ? { data } : {}),
    meta: { at: new Date().toISOString(), id: crypto.randomUUID() },
    type,
  };
}

/** Шаг eve: step.started и step.completed со входом шага. */
function step(turnId: string, stepIndex: number): object[] {
  return [
    event("step.started", { modelId: "fake", sequence: 0, stepIndex, turnId }),
    event("step.completed", {
      finishReason: "tool-calls",
      sequence: 0,
      stepIndex,
      turnId,
      usage: { inputTokens: 1000, outputTokens: 10 },
    }),
  ];
}

function turn(message: string, mode: FakeMode = "own"): object[] {
  const turnId = `turn_${crypto.randomUUID()}`;
  const opening = [
    event("message.received", { message, turnId }),
    event("turn.started", { turnId }),
  ];
  const own = (type: string) => event(type, { sequence: 0, turnId });
  const waiting = event("session.waiting", { wait: "next-user-message" });
  switch (mode) {
    // Ход, который ещё идёт: сервер принял сообщение, конца хода нет.
    case "hang":
    case "stream-breaks":
      return [...opening, ...step(turnId, 0)];
    // Ход кончился, а финального сообщения нет.
    case "no-report":
      return [...opening, ...step(turnId, 0), own("turn.completed"), waiting];
    // 121-й step.started (индекс 120) — предел; конец хода допишет cancel.
    case "cut":
      return [
        ...opening,
        ...Array.from({ length: 120 }, (_, i) => step(turnId, i)).flat(),
        event("step.started", {
          modelId: "fake",
          sequence: 0,
          stepIndex: 120,
          turnId,
        }),
      ];
    case "turn-failed":
      return [...opening, ...step(turnId, 0), own("turn.failed"), waiting];
    case "session-failed":
      return [
        ...opening,
        ...step(turnId, 0),
        event("session.failed", {
          code: "Error",
          message: "hook threw",
          sessionId: "fake",
        }),
      ];
    default:
      return [
        ...opening,
        ...step(turnId, 0),
        event("message.completed", {
          finishReason: "stop",
          message: "fake monthly report",
          sequence: 0,
          stepIndex: 0,
          turnId,
        }),
        own("turn.completed"),
        waiting,
      ];
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    assert.ok(typeof chunk === "string");
    body += chunk;
  }
  return body === "" ? undefined : JSON.parse(body);
}

function sendJson(
  response: import("node:http").ServerResponse,
  value: unknown,
  status = 200,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Запрос без ответа: ждёт, пока клиент сам не оборвёт соединение по своему сроку. */
const held = (response: import("node:http").ServerResponse) =>
  new Promise<void>((resolve) => response.once("close", () => resolve()));

class FakeEve {
  readonly requests: RecordedRequest[] = [];
  readonly server: Server;
  mode: FakeMode = "own";
  /** Режим хода по его промпту: у коррекции CORE и дня бывают разные сценарии. */
  modeFor?: (message: string) => FakeMode;
  /** Ответы create, потока и снятия приходят с задержкой: медленный сервер. */
  createDelayMs = 0;
  streamDelayMs = 0;
  resetDelayMs = 0;
  /** Ответ reset: штатный, no_active_session, чужой previousSessionId или 5xx. */
  resetReply: (
    sessionId: string,
  ) => "reset" | "no_active_session" | "foreign" | "error" = () => "reset";
  /** Когда сервер снял сессию: подтверждение reset ушло клиенту. */
  readonly resetAt = new Map<string, number>();
  /** Зависший cancel / reset: ответа нет, пока клиент сам не оборвёт запрос по сроку. */
  holdCancel = false;
  holdReset = false;
  /** Когда клиент оборвал зависший запрос (его срок сработал). */
  readonly cancelAbortedAt: number[] = [];
  readonly resetAbortedAt: number[] = [];
  /** Файловый эффект хода: тест дописывает vault так, как это сделала бы модель. */
  onTurn?: (message: string) => void;
  /** Хуки момента: POST create принят, GET потока, POST reset принят. */
  onCreate?: () => void;
  onStream?: (sessionId: string) => void;
  onReset?: (sessionId: string) => void;
  #nextSession = 1;
  #events = new Map<string, object[]>();
  #prompts = new Map<string, string>();

  constructor() {
    this.server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async #handle(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake-eve.invalid");
    const method = request.method ?? "GET";
    const body = method === "POST" ? await readJson(request) : undefined;
    this.requests.push({
      at: Date.now(),
      body,
      method,
      pathname: url.pathname,
      search: url.search,
    });

    if (method === "POST" && url.pathname === "/eve/v1/session") {
      const sessionId = `wrun_fake_${this.#nextSession++}`;
      const message = this.#message(body);
      this.#prompts.set(sessionId, message);
      this.#events.set(
        sessionId,
        turn(message, this.modeFor?.(message) ?? this.mode),
      );
      this.onTurn?.(message);
      this.onCreate?.();
      await pause(this.createDelayMs);
      sendJson(response, { sessionId });
      return;
    }

    const cancel = url.pathname.match(/^\/eve\/v1\/session\/([^/]+)\/cancel$/u);
    if (method === "POST" && cancel) {
      const cancelled = decodeURIComponent(cancel[1] ?? "");
      if (this.holdCancel) {
        await held(response);
        this.cancelAbortedAt.push(Date.now());
        return;
      }
      const events = this.#events.get(cancelled) ?? [];
      const turnId = events
        .map((item) => (item as { data?: { turnId?: string } }).data?.turnId)
        .find(Boolean);
      // Отмена идущего хода: eve дописывает его конец, клиент его дочитывает.
      this.#events.set(cancelled, [
        ...events,
        event("turn.cancelled", { sequence: 0, turnId }),
        event("session.waiting", { wait: "next-user-message" }),
      ]);
      sendJson(response, {
        ok: true,
        sessionId: cancelled,
        status: "accepted",
      });
      return;
    }

    const reset = url.pathname.match(/^\/eve\/v1\/session\/([^/]+)\/reset$/u);
    if (method === "POST" && reset) {
      const previousSessionId = decodeURIComponent(reset[1] ?? "");
      this.onReset?.(previousSessionId);
      if (this.holdReset) {
        await held(response);
        this.resetAbortedAt.push(Date.now());
        return;
      }
      await pause(this.resetDelayMs);
      const reply = this.resetReply(previousSessionId);
      if (reply === "error") {
        sendJson(response, { error: "unavailable" }, 503);
        return;
      }
      if (reply === "no_active_session") {
        sendJson(response, { ok: true, status: "no_active_session" });
        return;
      }
      if (reply === "reset") this.resetAt.set(previousSessionId, Date.now());
      sendJson(response, {
        ok: true,
        previousSessionId:
          reply === "foreign" ? "wrun_someone_else" : previousSessionId,
        status: "reset",
      });
      return;
    }

    const stream = url.pathname.match(/^\/eve\/v1\/session\/([^/]+)\/stream$/u);
    if (method === "GET" && stream) {
      const sessionId = decodeURIComponent(stream[1] ?? "");
      this.onStream?.(sessionId);
      await pause(this.streamDelayMs);
      const events = this.#events.get(sessionId) ?? [];
      const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
      // Поток рвётся на повторном GET: первые события (и turnId) клиент уже прочитал.
      if (this.#mode(sessionId) === "stream-breaks" && startIndex > 0) {
        sendJson(response, { error: "bad cursor" }, 400);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-eve-stream-tail-index": String(events.length - 1),
        "x-eve-stream-version": "25",
      });
      for (const item of events.slice(startIndex)) {
        response.write(`${JSON.stringify(item)}\n`);
      }
      response.end();
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  }

  #mode(sessionId: string): FakeMode {
    const message = this.#prompts.get(sessionId) ?? "";
    return this.modeFor?.(message) ?? this.mode;
  }

  #message(body: unknown): string {
    assert.ok(body && typeof body === "object" && !Array.isArray(body));
    assert.deepEqual(Object.keys(body), ["message"]);
    const message = (body as { message?: unknown }).message;
    assert.ok(typeof message === "string");
    return message;
  }
}

function makeRunDirectory(): {
  readonly data: string;
  readonly root: string;
  readonly vault: string;
} {
  // realpath: на macOS tmpdir лежит под /var → /private/var, и без него шов vault-commit
  // молча счёл бы отсутствующий CORE.md путём вне vault.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iva-rollup-client-")));
  const data = join(root, "data");
  const vault = join(root, "vault");
  mkdirSync(data);
  mkdirSync(vault);
  // Vault — свой git-репозиторий, как после init-vault: снимок CORE перед ходом — коммит.
  vaultGit(vault, "init", "-q");
  vaultGit(vault, "commit", "-q", "--allow-empty", "-m", "init-vault");
  return { data, root, vault };
}

/** git в vault от тестовой identity. */
function vaultGit(vault: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@x", ...args],
    { cwd: vault, encoding: "utf8" },
  );
}

/** Темы коммитов vault, новые первыми. */
const vaultLog = (vault: string): string[] =>
  vaultGit(vault, "log", "--format=%s").trim().split("\n");

interface RunOptions {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly onChild?: (child: import("node:child_process").ChildProcess) => void;
}

async function runRollup(
  host: string,
  paths: { readonly data: string; readonly vault: string },
  period = "monthly",
  { args = [], env = {}, onChild }: RunOptions = {},
): Promise<RollupRun> {
  return await new Promise<RollupRun>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [ROLLUP, period, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        ASSISTANT_BEARER: "",
        ASSISTANT_DATA_DIR: paths.data,
        ASSISTANT_HOST: host,
        ASSISTANT_TIMEZONE: "UTC",
        ASSISTANT_VAULT_DIR: paths.vault,
        // Раннер держит .memory.lock сам; дневной ход не стартует ближе 5 минут к сроку.
        IVA_MEMORY_LOCK_HELD: "1",
        IVA_JOB_STOP_AT: String(Date.now() + 10 * 60_000),
        TELEGRAM_ALLOWED_USER_IDS: "",
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_DIGEST_CHAT_ID: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    onChild?.(child);
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("rollup subprocess did not exit within 10 seconds"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    let exitAt = 0;
    child.once("exit", () => {
      exitAt = Date.now();
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, exitAt, signal, stderr, stdout });
    });
  });
}

test("production rollup creates a fresh session each run, resets it after the turn and drops its file", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const sessionFile = join(paths.data, SESSION_NAME);

  const first = await runRollup(host, paths);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(fake.requests[0]?.method, "POST");
  assert.equal(fake.requests[0]?.pathname, "/eve/v1/session");
  assert.equal(
    typeof (fake.requests[0]?.body as { message?: unknown }).message,
    "string",
    "create receives create({ message }) as a string on the public wire",
  );
  assert.deepEqual(sessionCalls(fake), ["create", "reset wrun_fake_1"]);
  assert.equal(existsSync(sessionFile), false, "the file outlives no turn");
  assert.equal(
    existsSync(join(paths.data, "rollup-abandoned.jsonl")),
    false,
    "a clean run abandons nothing",
  );

  const beforeSecond = fake.requests.length;
  const second = await runRollup(host, paths);
  assert.equal(second.code, 0, second.stderr);
  // Следующий запуск не возвращается в прошлую сессию: создаёт свою и снимает её.
  const secondRun = sessionCalls(fake).slice(2);
  assert.deepEqual(secondRun, ["create", "reset wrun_fake_2"]);
  assert.equal(fake.requests[beforeSecond]?.pathname, "/eve/v1/session");
  assert.equal(
    typeof (fake.requests[beforeSecond]?.body as { message?: unknown }).message,
    "string",
    "the second run creates with the prompt as a plain string",
  );
  assert.equal(
    fake.requests
      .slice(beforeSecond)
      .some(({ pathname }) => pathname.includes("wrun_fake_1")),
    false,
  );
  assert.equal(existsSync(sessionFile), false);
  assert.doesNotMatch(first.stderr + second.stderr, /could not reset/u);
  assert.equal(prompts(fake).length, 2, "one turn per run");
});

test("production rollup keeps the session file when the reset after the turn cannot be confirmed, and creates no second day", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(2), "## 10:00 [text]\n\nпозавчера\n");
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nвчера\n");
  fake.onTurn = markDayDone(paths.vault);
  fake.resetReply = () => "error";
  const sessionFile = join(paths.data, "rollup-session-daily.json");

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(sessionCalls(fake), ["create", "reset wrun_fake_1"]);
  assert.match(readFileSync(sessionFile, "utf8"), /"sessionId":"wrun_fake_1"/u);
  assert.match(run.stderr, /no new session in this one/u);
  assert.match(
    readFileSync(join(paths.data, "rollup-abandoned.jsonl"), "utf8"),
    /"reason":"\d{4}-\d{2}-\d{2}-completed-reset-failed","sessionId":"wrun_fake_1"/u,
  );
});

test("production rollup drops the saved session file after a no_active_session reset at start", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.resetReply = (id) =>
    id === "wrun_existing" ? "no_active_session" : "reset";
  const sessionFile = join(paths.data, SESSION_NAME);
  writeFileSync(
    sessionFile,
    JSON.stringify({ sessionId: "wrun_existing", createdAt: Date.now() }),
  );

  const run = await runRollup(host, paths);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(sessionCalls(fake), [
    "cancel wrun_existing",
    "reset wrun_existing",
    "create",
    "reset wrun_fake_1",
  ]);
  assert.equal(existsSync(sessionFile), false);
  assert.doesNotMatch(run.stderr, /was not reset/u);
  assert.match(
    readFileSync(join(paths.data, "rollup-abandoned.jsonl"), "utf8"),
    /"reason":"crash","sessionId":"wrun_existing"/u,
  );
});

test("a session file left after a crashed run is reset as crash before a fresh session", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const sessionFile = join(paths.data, SESSION_NAME);
  writeFileSync(
    sessionFile,
    JSON.stringify({ sessionId: "wrun_crashed", createdAt: Date.now() }),
  );

  const run = await runRollup(host, paths);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /fake monthly report/u, "the night itself runs");
  // Уборка сохранённой сессии идёт раньше всего: отмена её активного хода (id хода
  // неизвестен, с задачами), затем reset — сервер на reset живой ход не ждёт.
  assert.equal(
    fake.requests[0]?.pathname,
    "/eve/v1/session/wrun_crashed/cancel",
    "the crashed session is retired before anything else",
  );
  assert.deepEqual(fake.requests[0]?.body, { tasks: true });
  assert.deepEqual(sessionCalls(fake), [
    "cancel wrun_crashed",
    "reset wrun_crashed",
    "create",
    "reset wrun_fake_1",
  ]);
  assert.equal(
    sessionCalls(fake).includes("send wrun_crashed"),
    false,
    "the crashed session gets no second writer",
  );
  assert.deepEqual(
    cancelBodies(fake),
    [{ tasks: true }],
    "the fresh turn finished on its own: only the crashed session is cancelled",
  );
  assert.match(
    readFileSync(join(paths.data, "rollup-abandoned.jsonl"), "utf8"),
    /"reason":"crash","sessionId":"wrun_crashed"/u,
  );
  assert.equal(existsSync(sessionFile), false);
  assert.equal(prompts(fake).length, 1, "the crashed session gets no prompt");
  assert.doesNotMatch(run.stderr, /could not reset/u);
});

test("each missed day of one run gets a fresh session: the second day never goes to the first one's session", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(2), "## 10:00 [text]\n\nпозавчера\n");
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nвчера\n");
  fake.onTurn = markDayDone(paths.vault);

  const run = await runRollup(host, paths, "daily");
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(sessionCalls(fake), [
    "create",
    "reset wrun_fake_1",
    "create",
    "reset wrun_fake_2",
  ]);
  assert.equal(
    fake.requests.some(({ pathname }) => pathname.endsWith("/cancel")),
    false,
  );
  assert.equal(
    existsSync(join(paths.data, "rollup-session-daily.json")),
    false,
  );
});

test("a daily turn that hollows a section leaves the pre-turn CORE.md on disk", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const corePath = join(paths.vault, "CORE.md");
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const beforeTurn = [
    "# CORE",
    "",
    "## Предпочтения",
    "",
    "- 2026-07: отвечать коротко, без преамбул",
    "",
    "## Указатели",
    "",
    `- Последний день: summaries/daily/${yesterday} · Индекс: MOC.md`,
    "",
  ].join("\n");
  writeFileSync(corePath, beforeTurn);
  const hollowed = beforeTurn.replace(
    "- 2026-07: отвечать коротко, без преамбул",
    "",
  );
  let written = false;
  fake.onTurn = () => {
    if (written) return;
    written = true;
    writeFileSync(corePath, hollowed);
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  assert.equal(written, true, "the turn must have rewritten CORE.md");
  assert.equal(readFileSync(corePath, "utf8"), beforeTurn);
});

function cancelBodies(fake: FakeEve): unknown[] {
  return fake.requests
    .filter(
      ({ method, pathname }) =>
        method === "POST" && pathname.endsWith("/cancel"),
    )
    .map(({ body }) => body);
}

function prompts(fake: FakeEve): string[] {
  return fake.requests
    .filter(
      ({ method, pathname }) =>
        method === "POST" && /^\/eve\/v1\/session(?:\/[^/]+)?$/u.test(pathname),
    )
    .map(({ body }) => (body as { message: string }).message);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

const DONE_MARKER = "\n<!-- processed: 2026-09-23T04:10 -->\n";

/** Модель разбирает день из промпта и ставит отметку конца дня. */
function markDayDone(vault: string): (message: string) => void {
  return (message) => {
    const date = /daily\/(\d{4}-\d{2}-\d{2})\.md/u.exec(message)?.[1];
    assert.ok(date, "the daily prompt names the raw day it processes");
    const raw = join(vault, "daily", `${date}.md`);
    if (existsSync(raw))
      writeFileSync(raw, readFileSync(raw, "utf8") + DONE_MARKER);
  };
}

/** Двойник eve и каталог запуска, убираемые после теста. */
async function fakeEve(t: import("node:test").TestContext) {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  return { fake, host, paths };
}

/** Что сервер увидел по сессиям: создание, отправка, отмена, снятие — по порядку. */
function sessionCalls(fake: FakeEve): string[] {
  return fake.requests.flatMap(({ method, pathname }) => {
    if (method !== "POST") return [];
    if (pathname === "/eve/v1/session") return ["create"];
    const command = /^\/eve\/v1\/session\/([^/]+)\/(reset|cancel)$/u.exec(
      pathname,
    );
    if (command) return [`${command[2]} ${command[1]}`];
    const send = /^\/eve\/v1\/session\/([^/]+)$/u.exec(pathname);
    return send ? [`send ${send[1]}`] : [];
  });
}

/** Момент приёма сервером первого запроса этого вида к сессии. */
function requestAt(fake: FakeEve, suffix: string): number | undefined {
  return fake.requests.find(
    ({ method, pathname }) => method === "POST" && pathname.endsWith(suffix),
  )?.at;
}

function writeRawDay(vault: string, date: string, text: string): string {
  mkdirSync(join(vault, "daily"), { recursive: true });
  const path = join(vault, "daily", `${date}.md`);
  writeFileSync(path, text);
  return path;
}

test("a day turn is not started with less than five minutes before the job's stop time", async (t) => {
  const { fake, host, paths } = await fakeEve(t);

  const run = await runRollup(host, paths, "monthly", {
    env: { IVA_JOB_STOP_AT: String(Date.now() + 4 * 60_000) },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /is not started — \d+ s left before the stop time/u);
  assert.deepEqual(prompts(fake), [], "no session is created");
  assert.deepEqual(sessionCalls(fake), []);
});

test("SIGTERM from the runner stops the server turn the same way: one cancel with its turn and tasks, then a reset", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.mode = "hang";
  let child: import("node:child_process").ChildProcess | undefined;
  // Сигнал — на повторном GET потока: первые события хода (и его turnId) уже прочитаны.
  let gets = 0;
  fake.onStream = () => {
    if (++gets === 2) child?.kill("SIGTERM");
  };

  const run = await runRollup(host, paths, "monthly", {
    onChild: (spawned) => {
      child = spawned;
    },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.signal, null, "our handler, not the default kill");
  const [cancel] = cancelBodies(fake) as { tasks?: boolean; turnId?: string }[];
  assert.equal(cancel?.tasks, true);
  assert.match(cancel?.turnId ?? "", /^turn_/u);
  assert.deepEqual(sessionCalls(fake), [
    "create",
    "cancel wrun_fake_1",
    "reset wrun_fake_1",
  ]);
  assert.equal(existsSync(join(paths.data, SESSION_NAME)), false);
});

test("a model failure without a report is a failed night, and its session is reset without a cancel", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.mode = "no-report";

  const run = await runRollup(host, paths);

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /no report/u);
  assert.deepEqual(cancelBodies(fake), [], "the turn ended on its own");
  assert.deepEqual(sessionCalls(fake), ["create", "reset wrun_fake_1"]);
});

test("a day cut mid-way resumes after its last part marker", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const yesterday = isoDaysAgo(1);
  writeRawDay(
    paths.vault,
    yesterday,
    // Скилл дописывает отметку части в конец законченного дня, после всех записей.
    "## 09:00 [text]\n\nутро\n\n## 12:05 [iva]\n\nответ\n\n" +
      "## 18:30 [text]\n\nвечер\n\n<!-- processed-through: 12:05 -->\n",
  );
  mkdirSync(join(paths.vault, "summaries", "daily"), { recursive: true });
  writeFileSync(
    join(paths.vault, "summaries", "daily", `${yesterday}.md`),
    "# part one\n",
  );
  fake.onTurn = markDayDone(paths.vault);

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  const sent = prompts(fake);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /after 12:05/u);
});

test("missed days are caught up oldest first in one run", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const missed = isoDaysAgo(2);
  const yesterday = isoDaysAgo(1);
  writeRawDay(paths.vault, missed, "## 10:00 [text]\n\nпропущенный\n");
  writeRawDay(paths.vault, yesterday, "## 10:00 [text]\n\nвчера\n");
  fake.onTurn = markDayDone(paths.vault);

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  const days = prompts(fake).map(
    (prompt) => /daily\/(\d{4}-\d{2}-\d{2})\.md/u.exec(prompt)?.[1],
  );
  assert.deepEqual(days, [missed, yesterday]);
});

test("the rollup takes a concrete date", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  writeRawDay(paths.vault, "2026-09-10", "## 10:00 [text]\n\nдень\n");
  fake.onTurn = markDayDone(paths.vault);

  const run = await runRollup(host, paths, "daily", { args: ["2026-09-10"] });

  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(
    prompts(fake).map((prompt) => prompt.includes("daily/2026-09-10.md")),
    [true],
  );
});

test("a report without the day marked done is a failed night, not a done one", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /not marked done/u);
});

for (const how of ["SIGTERM", "SIGINT"] as const) {
  test(`on ${how} the process exits only after the server confirms the turn stopped`, async (t) => {
    const { fake, host, paths } = await fakeEve(t);
    fake.mode = "hang";
    // Снятие отвечает не сразу: выход раньше подтверждения — живой писатель.
    fake.resetDelayMs = 1000;
    let child: import("node:child_process").ChildProcess | undefined;
    fake.onStream = () => child?.kill(how);

    const run = await runRollup(host, paths, "monthly", {
      onChild: (spawned) => {
        child = spawned;
      },
    });

    assert.equal(run.code, 1, run.stderr);
    const resetAt = fake.resetAt.get("wrun_fake_1");
    assert.ok(resetAt, "the server session was reset");
    assert.ok(
      resetAt <= run.exitAt,
      "the process exited before the server confirmed the reset",
    );
  });
}

test("SIGTERM while resetting a crashed session keeps the send from going out", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.resetDelayMs = 800;
  const sessionFile = join(paths.data, SESSION_NAME);
  writeFileSync(
    sessionFile,
    JSON.stringify({ sessionId: "wrun_saved", createdAt: Date.now() }),
  );
  let child: import("node:child_process").ChildProcess | undefined;
  // Сигнал — когда reset сохранённой сессии уже дошёл до сервера (QA T93-R3 G2).
  fake.onReset = () => child?.kill("SIGTERM");

  const run = await runRollup(host, paths, "monthly", {
    onChild: (spawned) => {
      child = spawned;
    },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.signal, null, "the handler was in place");
  assert.deepEqual(prompts(fake), [], "no turn may start after the stop");
  assert.deepEqual(sessionCalls(fake), [
    "cancel wrun_saved",
    "reset wrun_saved",
  ]);
  assert.equal(
    existsSync(sessionFile),
    false,
    "the confirmed reset still removes the file",
  );
});

test("a second signal during the cleanup does not kill the process: the cleanup reaches the reset", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.mode = "hang";
  fake.resetDelayMs = 800;
  let child: import("node:child_process").ChildProcess | undefined;
  fake.onStream = () => child?.kill("SIGTERM");
  fake.onReset = () => child?.kill("SIGTERM");

  const run = await runRollup(host, paths, "monthly", {
    onChild: (spawned) => {
      child = spawned;
    },
  });

  assert.equal(run.signal, null, "the second SIGTERM did not kill it");
  assert.equal(run.code, 1, run.stderr);
  assert.ok(fake.resetAt.get("wrun_fake_1"), "the reset was confirmed");
  assert.equal(existsSync(join(paths.data, SESSION_NAME)), false);
});

test("a summary without the processed mark still fails the night", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const yesterday = isoDaysAgo(1);
  writeRawDay(paths.vault, yesterday, "## 10:00 [text]\n\nдень\n");
  // Ход написал сводку части и оборвался до отметки конца.
  fake.onTurn = () => {
    mkdirSync(join(paths.vault, "summaries", "daily"), { recursive: true });
    writeFileSync(
      join(paths.vault, "summaries", "daily", `${yesterday}.md`),
      "# part one\n",
    );
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /not marked done/u);
});

test("today and future dates are refused: only a finished day can be marked done", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  for (const date of [isoDaysAgo(0), "2099-01-01"]) {
    const run = await runRollup(host, paths, "daily", { args: [date] });
    assert.equal(run.code, 1, `${date}: ${run.stderr}`);
    assert.match(run.stderr, /not a finished day/u);
  }
  assert.deepEqual(prompts(fake), []);
});

test("an undone day leaving the catch-up window is named in the log", async (t) => {
  const fake = new FakeEve();
  const host = await fake.start();
  const paths = makeRunDirectory();
  t.after(async () => {
    await fake.stop();
    rmSync(paths.root, { force: true, recursive: true });
  });
  const leaving = isoDaysAgo(8);
  writeRawDay(paths.vault, leaving, "## 10:00 [text]\n\nзабытый день\n");
  writeRawDay(
    paths.vault,
    isoDaysAgo(1),
    `## 10:00 [text]\n\nвчера\n${DONE_MARKER}`,
  );

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  assert.match(
    run.stderr,
    new RegExp(`${leaving}.*left the catch-up window`, "u"),
  );
});

// ── Сессия, предел и попытки: таблица отказов T96 (specs/NightSession.tla) ─────────────

/** CORE с пользовательскими предпочтениями и указателем на вчера; extra раздувает файл. */
function writeCore(
  vault: string,
  extra = "",
  lastDay = isoDaysAgo(1),
): { path: string; text: string } {
  const path = join(vault, "CORE.md");
  const text = [
    "# CORE",
    "",
    "## Предпочтения",
    "",
    "- 2026-07: отвечать коротко, без преамбул",
    extra,
    "",
    "## Указатели",
    "",
    `- Последний день: summaries/daily/${lastDay} · Индекс: MOC.md`,
    "",
  ].join("\n");
  writeFileSync(path, text);
  return { path, text };
}

/** Правка файла ходом; фикстура без искомой строки — ошибка теста, а не тихий no-op. */
function editCore(path: string, replacement: string): void {
  const before = readFileSync(path, "utf8");
  const after = before.replace(
    "- 2026-07: отвечать коротко, без преамбул",
    replacement,
  );
  assert.notEqual(after, before, `${path}: the fixture line is not there`);
  writeFileSync(path, after);
}

const hollow = (path: string) => editCore(path, "");

/** Правка хода внутри непустого раздела: заголовки целы, только байты другие. */
const appendLine = (
  path: string,
  line = "- 2026-09: полуправка оборванного хода",
) => editCore(path, `- 2026-07: отвечать коротко, без преамбул\n${line}`);

function attemptsOf(data: string): Record<string, { reason: string }[]> {
  const file = join(data, "rollup-attempts.json");
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        { reason: string }[]
      >)
    : {};
}

test("a legacy or unreadable session file stops the run before any session is created", async (t) => {
  for (const junk of [
    "{broken",
    JSON.stringify({
      createdAt: Date.now(),
      state: { sessionId: "wrun_legacy", streamIndex: 19 },
    }),
  ]) {
    const { fake, host, paths } = await fakeEve(t);
    const sessionFile = join(paths.data, SESSION_NAME);
    writeFileSync(sessionFile, junk);

    const run = await runRollup(host, paths);

    assert.equal(run.code, 1, run.stderr);
    assert.deepEqual(fake.requests, [], "fail closed: no reset, no create");
    assert.equal(readFileSync(sessionFile, "utf8"), junk);
    assert.match(
      run.stderr,
      /rollup-session-monthly\.json is unreadable or not a session file/u,
    );
  }
});

test("a reset refused at start (a foreign previousSessionId or a 503) keeps the file and creates nothing", async (t) => {
  for (const reply of ["foreign", "error"] as const) {
    const { fake, host, paths } = await fakeEve(t);
    fake.resetReply = () => reply;
    const sessionFile = join(paths.data, SESSION_NAME);
    writeFileSync(
      sessionFile,
      JSON.stringify({ sessionId: "wrun_saved", createdAt: 1 }),
    );

    const run = await runRollup(host, paths);

    assert.equal(run.code, 1, run.stderr);
    assert.deepEqual(
      sessionCalls(fake),
      ["cancel wrun_saved", "reset wrun_saved"],
      reply,
    );
    assert.match(readFileSync(sessionFile, "utf8"), /wrun_saved/u);
  }
});

test("a saved session is reset and removed before a bad vault setting ends the run", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const sessionFile = join(paths.data, SESSION_NAME);
  writeFileSync(
    sessionFile,
    JSON.stringify({ sessionId: "wrun_saved", createdAt: 1 }),
  );

  const run = await runRollup(host, paths, "monthly", {
    // Пробел по краю — VaultDirError: инициализация падает уже после уборки.
    env: { ASSISTANT_VAULT_DIR: ` ${paths.vault}` },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(sessionCalls(fake), [
    "cancel wrun_saved",
    "reset wrun_saved",
  ]);
  assert.equal(existsSync(sessionFile), false);
  assert.deepEqual(prompts(fake), []);
});

test("the lock path comes from the resolver: without the runner's flag the run re-execs itself under flock, the stop time notwithstanding", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const bin = join(paths.root, "bin");
  mkdirSync(bin);
  const argsFile = join(paths.root, "flock-args");
  writeFileSync(
    join(bin, "flock"),
    `#!/bin/sh\necho "$@" > "${argsFile}"\nexit 0\n`,
    {
      mode: 0o755,
    },
  );

  const run = await runRollup(host, paths, "monthly", {
    env: { IVA_MEMORY_LOCK_HELD: "", PATH: bin },
  });

  assert.equal(run.code, 0, run.stderr);
  assert.ok(
    readFileSync(argsFile, "utf8").startsWith(
      `-n -E 75 ${join(ROOT, ".memory.lock")} `,
    ),
  );
  assert.deepEqual(fake.requests, [], "nothing ran outside the lock");
});

test("a day cut by the turn ceiling is partial progress: one cancel, an attempt, CORE restored, the next day still runs, exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const older = isoDaysAgo(2);
  const yesterday = isoDaysAgo(1);
  writeRawDay(paths.vault, older, "## 10:00 [text]\n\nпозавчера\n");
  writeRawDay(paths.vault, yesterday, "## 10:00 [text]\n\nвчера\n");
  const core = writeCore(paths.vault);
  const done = markDayDone(paths.vault);
  fake.modeFor = (message) =>
    message.includes(`daily/${older}.md`) ? "cut" : "own";
  fake.onTurn = (message) => {
    if (message.includes(`daily/${older}.md`)) hollow(core.path);
    else done(message);
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  const cancels = cancelBodies(fake) as { tasks?: boolean; turnId?: string }[];
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0]?.tasks, true);
  assert.match(cancels[0]?.turnId ?? "", /^turn_/u);
  assert.deepEqual(sessionCalls(fake), [
    "create",
    "cancel wrun_fake_1",
    "reset wrun_fake_1",
    "create",
    "reset wrun_fake_2",
  ]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(attemptsOf(paths.data)).map(([day, list]) => [
        day,
        list.map(({ reason }) => reason),
      ]),
    ),
    { [older]: ["cut"] },
  );
  assert.equal(readFileSync(core.path, "utf8"), core.text, "CORE is back");
  assert.match(
    run.stderr,
    new RegExp(`${older} was cut by the turn ceiling`, "u"),
  );
});

test("three observed failures pause the day, and the next run leaves it to the owner with the skip command", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const yesterday = isoDaysAgo(1);
  writeRawDay(paths.vault, yesterday, "## 10:00 [text]\n\nтяжёлый день\n");
  const at = new Date().toISOString();
  writeFileSync(
    join(paths.data, "rollup-attempts.json"),
    JSON.stringify({
      [yesterday]: [
        { at, reason: "cut" },
        { at, reason: "cut" },
      ],
    }),
  );
  fake.mode = "no-report";

  const third = await runRollup(host, paths, "daily");
  assert.equal(third.code, 1, third.stderr);
  assert.equal(attemptsOf(paths.data)[yesterday]?.length, 3);

  const next = await runRollup(host, paths, "daily");
  assert.equal(next.code, 0, next.stderr);
  assert.equal(prompts(fake).length, 1, "the paused day is not tried again");
  assert.match(next.stdout, /wait for the owner/u);
  assert.match(
    next.stderr,
    new RegExp(`iva jobs skip memory-daily ${yesterday}`, "u"),
  );
});

test("a failed turn (turn.failed) counts no attempt of the day, and its tasks are cancelled before the reset", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  fake.mode = "turn-failed";

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(attemptsOf(paths.data), {});
  assert.match(run.stderr, /the turn ended failed — no attempt is counted/u);
  // Отказ хода снимает задачи: отмена с задачами своего хода, затем reset.
  const [cancel] = cancelBodies(fake) as { tasks?: boolean; turnId?: string }[];
  assert.equal(cancel?.tasks, true);
  assert.match(cancel?.turnId ?? "", /^turn_/u);
  assert.deepEqual(sessionCalls(fake), [
    "create",
    "cancel wrun_fake_1",
    "reset wrun_fake_1",
  ]);
});

test("session.failed resets the session only, never cancels, counts no attempt and restores CORE byte for byte", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  fake.mode = "session-failed";
  // Ход дописал строку в непустой раздел и закоммитил её, как write_file модели: заголовки
  // целы, coreDamage этого не видит.
  fake.onTurn = () => {
    appendLine(core.path);
    vaultGit(paths.vault, "add", "-A");
    vaultGit(paths.vault, "commit", "-q", "-m", "turn: half-edit");
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(cancelBodies(fake), []);
  assert.deepEqual(sessionCalls(fake), ["create", "reset wrun_fake_1"]);
  assert.deepEqual(attemptsOf(paths.data), {});
  assert.equal(readFileSync(core.path, "utf8"), core.text);
  assert.match(run.stderr, /CORE\.md is back to its pre-turn text/u);
  // Снимок — коммит истории vault: грязная фикстура закоммичена перед ходом, откат — после.
  assert.deepEqual(vaultLog(paths.vault).slice(0, 3), [
    `file CORE.md: restore (${isoDaysAgo(1)} session-failed)`,
    "turn: half-edit",
    "file CORE.md: before turn",
  ]);
});

for (const mode of ["turn-failed", "stream-breaks"] as const) {
  test(`a turn that ends ${mode} after adding a line to a non-empty CORE section leaves CORE byte-equal to its snapshot`, async (t) => {
    const { fake, host, paths } = await fakeEve(t);
    writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
    const core = writeCore(paths.vault);
    fake.mode = mode;
    fake.onTurn = () => appendLine(core.path);

    const run = await runRollup(host, paths, "daily");

    assert.equal(run.code, 1, run.stderr);
    assert.deepEqual(attemptsOf(paths.data), {});
    assert.equal(readFileSync(core.path, "utf8"), core.text, mode);
    assert.equal(
      cancelBodies(fake).length,
      1,
      "the turn or its tasks are cancelled once",
    );
    assert.deepEqual(sessionCalls(fake), [
      "create",
      "cancel wrun_fake_1",
      "reset wrun_fake_1",
    ]);
  });
}

test("SIGTERM while a daily turn is read restores CORE byte for byte, and exits only after cancel and reset", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  fake.mode = "hang";
  fake.resetDelayMs = 300;
  fake.onTurn = () => appendLine(core.path);
  let child: import("node:child_process").ChildProcess | undefined;
  let gets = 0;
  fake.onStream = () => {
    if (++gets === 2) child?.kill("SIGTERM");
  };

  const run = await runRollup(host, paths, "daily", {
    onChild: (spawned) => {
      child = spawned;
    },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.signal, null);
  assert.equal(readFileSync(core.path, "utf8"), core.text);
  assert.deepEqual(attemptsOf(paths.data), {});
  const cancelAt = requestAt(fake, "/cancel");
  const resetAt = fake.resetAt.get("wrun_fake_1");
  assert.ok(cancelAt && resetAt, "cancel and reset reached the server");
  assert.ok(cancelAt <= requestAt(fake, "/reset")!, "cancel goes first");
  assert.ok(resetAt <= run.exitAt, "the exit waits for the confirmed reset");
});

test("the CORE snapshot is taken per turn: a failed second day rolls back to the first day's legitimate edit, not to the run start", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const older = isoDaysAgo(2);
  const yesterday = isoDaysAgo(1);
  writeRawDay(paths.vault, older, "## 10:00 [text]\n\nпозавчера\n");
  writeRawDay(paths.vault, yesterday, "## 10:00 [text]\n\nвчера\n");
  const core = writeCore(paths.vault);
  const done = markDayDone(paths.vault);
  let afterDayOne = "";
  fake.modeFor = (message) =>
    message.includes(`daily/${older}.md`) ? "own" : "session-failed";
  fake.onTurn = (message) => {
    if (message.includes(`daily/${older}.md`)) {
      appendLine(core.path, "- 2026-09: законная правка дня 1");
      afterDayOne = readFileSync(core.path, "utf8");
      done(message);
    } else appendLine(core.path, "- 2026-09: полуправка упавшего дня 2");
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.notEqual(afterDayOne, core.text);
  assert.equal(readFileSync(core.path, "utf8"), afterDayOne);
});

test("an unconfirmed reset after a turn leaves the vault alone: CORE keeps the turn's edit, no restore, the file stays, exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  fake.mode = "session-failed";
  fake.resetReply = () => "error";
  fake.onTurn = () => appendLine(core.path);

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  // Ход может быть жив: второго писателя CORE ночь не добавляет.
  assert.notEqual(readFileSync(core.path, "utf8"), core.text);
  assert.doesNotMatch(
    run.stderr,
    /back to its pre-turn text|restored the pre-turn file/u,
  );
  assert.match(
    readFileSync(join(paths.data, "rollup-session-daily.json"), "utf8"),
    /wrun_fake_1/u,
  );
});

test("an unconfirmed reset after a completed turn skips the damage check too: a hollowed section is not restored while the turn may be live", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  fake.resetReply = () => "error";
  fake.onTurn = () => hollow(core.path);

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.notEqual(readFileSync(core.path, "utf8"), core.text);
  assert.doesNotMatch(run.stderr, /restored the pre-turn file/u);
});

test("a confirmed cut with an unconfirmed reset still counts the day's attempt, and the catch-up stops there", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const older = isoDaysAgo(2);
  writeRawDay(paths.vault, older, "## 10:00 [text]\n\nпозавчера\n");
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nвчера\n");
  fake.mode = "cut";
  fake.resetReply = () => "error";

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(
    Object.entries(attemptsOf(paths.data)).map(([day, list]) => [
      day,
      list.map(({ reason }) => reason),
    ]),
    [[older, ["cut"]]],
  );
  assert.equal(
    prompts(fake).length,
    1,
    "no second day after an unconfirmed reset",
  );
  assert.deepEqual(sessionCalls(fake), [
    "create",
    "cancel wrun_fake_1",
    "reset wrun_fake_1",
  ]);
});

test("a CORE correction whose session is not retired leaves CORE as the turn left it", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(
    paths.vault,
    `- ${"длинное предпочтение ".repeat(200)}`,
  );
  const done = markDayDone(paths.vault);
  fake.resetReply = (id) => (id === "wrun_fake_2" ? "error" : "reset");
  fake.onTurn = (message) => {
    if (message.includes("Re-open")) writeFileSync(core.path, "# CORE\n");
    else done(message);
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.equal(readFileSync(core.path, "utf8"), "# CORE\n");
  assert.match(run.stderr, /correction completed, its session is not retired/u);
});

// Сроки процесса: срок запуска и сроки уборки укорочены через шов rollup-turn.ts, чтобы
// проводка IVA_JOB_STOP_AT → таймер → остановка → cancel → reset → выход и границы
// зависшей уборки прошли за секунды. Двойник держит ответ, пока клиент сам не оборвёт запрос.
test("a turn past the job's stop time is cancelled with its tasks and reset before the process exits", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.mode = "hang";

  const run = await runRollup(host, paths, "monthly", {
    env: {
      IVA_JOB_STOP_AT: String(Date.now() + 2500),
      IVA_NIGHT_TEST_DEADLINES: "1",
      IVA_NIGHT_MIN_TURN_MS: "500",
    },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.signal, null, "the stop time is our own handler");
  assert.match(run.stderr, /stop time — stopping/u);
  const [cancel] = cancelBodies(fake) as { tasks?: boolean; turnId?: string }[];
  assert.equal(cancel?.tasks, true);
  assert.match(cancel?.turnId ?? "", /^turn_/u);
  assert.deepEqual(sessionCalls(fake), [
    "create",
    "cancel wrun_fake_1",
    "reset wrun_fake_1",
  ]);
  const resetAt = fake.resetAt.get("wrun_fake_1");
  assert.ok(resetAt && resetAt <= run.exitAt, "the exit waits for the reset");
  assert.equal(existsSync(join(paths.data, SESSION_NAME)), false);
});

test("a reset that hangs at start ends by its own deadline: the file is kept, nothing is created, exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.holdReset = true;
  const sessionFile = join(paths.data, SESSION_NAME);
  writeFileSync(
    sessionFile,
    JSON.stringify({ sessionId: "wrun_saved", createdAt: 1 }),
  );

  const startedAt = Date.now();
  const run = await runRollup(host, paths, "monthly", {
    env: {
      IVA_NIGHT_TEST_DEADLINES: "1",
      IVA_NIGHT_CANCEL_MS: "300",
      IVA_NIGHT_RESET_MS: "500",
    },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(sessionCalls(fake), [
    "cancel wrun_saved",
    "reset wrun_saved",
  ]);
  assert.equal(fake.resetAbortedAt.length, 1, "the client gave up the reset");
  assert.ok(
    run.exitAt - startedAt < 5000,
    "the deadline, not the runner, ended it",
  );
  assert.match(run.stderr, /was not reset .*keeps it for the next run/u);
  assert.match(readFileSync(sessionFile, "utf8"), /wrun_saved/u);
  assert.deepEqual(prompts(fake), []);
});

test("a cancel that hangs is bounded by its own deadline: the reset follows it, and the process exits after the reset", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.mode = "hang";
  fake.holdCancel = true;
  let child: import("node:child_process").ChildProcess | undefined;
  let gets = 0;
  fake.onStream = () => {
    if (++gets === 2) child?.kill("SIGTERM");
  };

  const run = await runRollup(host, paths, "monthly", {
    env: { IVA_NIGHT_TEST_DEADLINES: "1", IVA_NIGHT_CANCEL_MS: "300" },
    onChild: (spawned) => {
      child = spawned;
    },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.signal, null);
  assert.equal(fake.cancelAbortedAt.length, 1, "the client gave up the cancel");
  const resetRequestedAt = requestAt(fake, "/reset");
  const cancelAbortedAt = fake.cancelAbortedAt[0];
  assert.ok(
    resetRequestedAt && cancelAbortedAt && cancelAbortedAt <= resetRequestedAt,
    "the reset waits for the cancel to end",
  );
  const resetAt = fake.resetAt.get("wrun_fake_1");
  assert.ok(resetAt && resetAt <= run.exitAt);
  assert.match(run.stderr, /cancel of turn turn_[^ ]+: failed/u);
  assert.equal(existsSync(join(paths.data, SESSION_NAME)), false);
});

test("a create that SIGTERM aborts before its response leaves the session id unknown: exit 1, nothing reset", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.createDelayMs = 1500;
  let child: import("node:child_process").ChildProcess | undefined;
  fake.onCreate = () => child?.kill("SIGTERM");

  const run = await runRollup(host, paths, "monthly", {
    onChild: (spawned) => {
      child = spawned;
    },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.signal, null);
  assert.deepEqual(sessionCalls(fake), ["create"]);
  assert.match(run.stderr, /session id unknown/u);
  assert.match(
    readFileSync(join(paths.data, "rollup-abandoned.jsonl"), "utf8"),
    /"reason":"\d{4}-\d{2}-\d{2}-create-failed","sessionId":null/u,
  );
  assert.equal(existsSync(join(paths.data, SESSION_NAME)), false);
});

test("the session file names the session while its turn is read", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const seen: string[] = [];
  fake.onStream = () =>
    seen.push(readFileSync(join(paths.data, SESSION_NAME), "utf8"));

  const run = await runRollup(host, paths);

  assert.equal(run.code, 0, run.stderr);
  const saved = JSON.parse(seen[0] ?? "{}") as Record<string, unknown>;
  assert.deepEqual(Object.keys(saved).sort(), ["createdAt", "sessionId"]);
  assert.equal(saved.sessionId, "wrun_fake_1");
});

test("the CORE correction runs in its own session with the core-format section, and leaves no session file", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(
    paths.vault,
    `- ${"длинное предпочтение ".repeat(200)}`,
  );
  const done = markDayDone(paths.vault);
  fake.onTurn = (message) => {
    if (message.includes("Re-open")) writeCore(paths.vault);
    else done(message);
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  const [, correction = ""] = prompts(fake);
  const rule = readFileSync(
    join(ROOT, "scripts/memory/instructions/rules/core-format.md"),
    "utf8",
  )
    .replace(/^---\n[\s\S]*?\n---\n/u, "")
    .trim();
  assert.ok(correction.startsWith(`### Rules: core-format\n\n${rule}\n\n`));
  assert.deepEqual(sessionCalls(fake), [
    "create",
    "reset wrun_fake_1",
    "create",
    "reset wrun_fake_2",
  ]);
  assert.equal(
    existsSync(join(paths.data, "rollup-session-daily.json")),
    false,
  );
  assert.ok(readFileSync(core.path, "utf8").length < core.text.length);
});

test("a CORE correction cut by the turn ceiling leaves CORE as it was before the correction", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(
    paths.vault,
    `- ${"длинное предпочтение ".repeat(200)}`,
  );
  const done = markDayDone(paths.vault);
  fake.modeFor = (message) => (message.includes("Re-open") ? "cut" : "own");
  fake.onTurn = (message) => {
    // Обрезанная коррекция успела выбросить раздел.
    if (message.includes("Re-open")) writeFileSync(core.path, "# CORE\n");
    else done(message);
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.equal(readFileSync(core.path, "utf8"), core.text);
  assert.match(
    run.stderr,
    /CORE\.md correction cut — CORE\.md is back to its pre-correction text/u,
  );
});

test("an unwritable session file after create resets the new session and ends the run", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.onCreate = () => chmodSync(paths.data, 0o555);

  const run = await runRollup(host, paths);
  chmodSync(paths.data, 0o755);

  assert.equal(run.code, 1, run.stderr);
  // Ход уже идёт на сервере, а его id не наблюдался: отмена активного хода, затем reset.
  assert.deepEqual(sessionCalls(fake), [
    "create",
    "cancel wrun_fake_1",
    "reset wrun_fake_1",
  ]);
  assert.deepEqual(cancelBodies(fake), [{ tasks: true }]);
  assert.equal(
    fake.requests.some(({ pathname }) => pathname.endsWith("/stream")),
    false,
    "an unsaved session is never read",
  );
});

test("a session file that cannot be removed after the turn ends the run, and the next run resets that session first", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  fake.onStream = () => chmodSync(paths.data, 0o555);

  const run = await runRollup(host, paths);
  chmodSync(paths.data, 0o755);
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /was not removed/u);

  fake.onStream = undefined;
  const next = await runRollup(host, paths);
  assert.equal(next.code, 0, next.stderr);
  assert.deepEqual(sessionCalls(fake).slice(2, 4), [
    "cancel wrun_fake_1",
    "reset wrun_fake_1",
  ]);
});

test("a client error after the turn (an unreadable day) resets the session, counts no attempt and ends the run", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const raw = writeRawDay(
    paths.vault,
    isoDaysAgo(1),
    "## 10:00 [text]\n\nдень\n",
  );
  fake.onTurn = () => chmodSync(raw, 0o000);

  const run = await runRollup(host, paths, "daily");
  chmodSync(raw, 0o644);

  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(sessionCalls(fake), ["create", "reset wrun_fake_1"]);
  assert.deepEqual(attemptsOf(paths.data), {});
  assert.match(run.stderr, /EACCES/u);
});

// Правила ночи идут в промпт текстом (#249): в версионной раскладке путь внутрь
// scripts/memory/instructions/ модель прочитать не может. Список — второй независимый
// источник: каждый файл набора стоит в промпте целиком (без frontmatter) под своим разделом.
const NIGHT_RULES: Record<string, readonly string[]> = {
  daily: [
    "memory-processor/SKILL.md",
    "memory-processor/phases/capture.md",
    "memory-processor/phases/process.md",
    "memory-processor/phases/link.md",
    "memory-processor/phases/summarize.md",
    "memory-processor/references/classification.md",
    "memory-processor/references/card-templates.md",
    "memory-processor/references/linking.md",
    "rules/daily-format.md",
    "rules/core-format.md",
  ],
  weekly: ["rules/weekly-reflection.md"],
  monthly: ["rules/monthly-format.md"],
  yearly: ["rules/yearly-format.md"],
};

for (const [period, files] of Object.entries(NIGHT_RULES)) {
  test(`the ${period} prompt carries its rules as text, with no path into the instructions`, async (t) => {
    const fake = new FakeEve();
    const host = await fake.start();
    const paths = makeRunDirectory();
    t.after(async () => {
      await fake.stop();
      rmSync(paths.root, { force: true, recursive: true });
    });
    if (period === "daily") {
      writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
      fake.onTurn = markDayDone(paths.vault);
    }

    const run = await runRollup(host, paths, period);

    assert.equal(run.code, 0, run.stderr);
    const [prompt = ""] = prompts(fake);
    assert.doesNotMatch(prompt, /scripts\/memory\/instructions/u);
    for (const file of files) {
      const text = readFileSync(
        join(ROOT, "scripts/memory/instructions", file),
        "utf8",
      );
      const body = text.replace(/^---\n[\s\S]*?\n---\n/u, "").trim();
      const name = file.endsWith("/SKILL.md")
        ? "memory-processor"
        : file.replace(/^.*\//u, "").replace(/\.md$/u, "");
      assert.ok(
        prompt.includes(`### Rules: ${name}\n\n${body}`),
        `${period}: ${file} goes in whole under its section`,
      );
      assert.equal(
        prompt.split(`### Rules: ${name}\n`).length,
        2,
        `${period}: ${name} goes in once`,
      );
      const frontmatter = /^---\n[\s\S]*?\n---\n/u.exec(text)?.[0];
      if (frontmatter)
        assert.ok(
          !prompt.includes(frontmatter),
          `${period}: ${file} frontmatter`,
        );
    }
    // Вне блоков кода — ни одного имени файла правил, в кавычках или без.
    const prose = prompt.replace(/```[\s\S]*?```/gu, "");
    const ruleFiles =
      /\b(?:SKILL|capture|process|link|summarize|classification|card-templates|linking|daily-summary|[a-z]+-format|weekly-reflection)\.md\b|\b(?:rules|phases|references)\//u;
    assert.doesNotMatch(prose, ruleFiles);
    // Хвост доставки последний, задание ночи — после правил и до хвоста.
    const task = prompt.indexOf("## Tonight's task");
    const tail = prompt.indexOf("At the end, return a SHORT report");
    assert.ok(task > 0 && tail > task, `${period}: the task follows the rules`);
    // Что вернуть, решает только хвост доставки: у правил ночи своего «верни» нет.
    assert.doesNotMatch(prompt.slice(0, tail), /^(?:#+ .*Hand back|Return )/mu);
    assert.match(
      prompt.slice(tail),
      /^At the end, return a SHORT report[^]*Only the finished report, with no preamble or reasoning\.$/u,
    );
  });
}

// Коррекция идёт после записи указателя: откат возвращает снимок с новым указателем, а не
// файл до ночи. Указатель фикстуры заведомо устаревший, чтобы эти два текста различались.
for (const [how, spoil] of [
  [
    "returns a bare '# CORE'",
    (path: string) => writeFileSync(path, "# CORE\n"),
  ],
  ["deletes CORE.md", (path: string) => rmSync(path)],
] as const) {
  test(`a completed CORE correction that ${how} fails the damage check: CORE is back to the text after the pointer, exit 1, the owner is alerted`, async (t) => {
    const { fake, host, paths } = await fakeEve(t);
    const yesterday = isoDaysAgo(1);
    writeRawDay(paths.vault, yesterday, "## 10:00 [text]\n\nдень\n");
    const core = writeCore(
      paths.vault,
      `- ${"длинное предпочтение ".repeat(200)}`,
      isoDaysAgo(3),
    );
    const pointed = setLastDayPointer(core.text, yesterday);
    assert.notEqual(pointed, core.text, "the fixture pointer is stale");
    // Фикстура закоммичена (CORE чистый — коммита «before turn» не будет); ход коммитит свою
    // порчу, как write_file модели: откат тогда меняет дерево против HEAD и виден в истории.
    const git = (...args: string[]) => vaultGit(paths.vault, ...args);
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    const done = markDayDone(paths.vault);
    fake.onTurn = (message) => {
      if (message.includes("Re-open")) {
        spoil(core.path);
        git("add", "-A");
        git("commit", "-q", "-m", "turn: spoil");
      } else done(message);
    };

    const run = await runRollup(host, paths, "daily");

    assert.equal(run.code, 1, run.stderr);
    assert.equal(readFileSync(core.path, "utf8"), pointed);
    assert.match(run.stderr, /CORE\.md lost .*restored the pre-turn file/u);
    assert.match(run.stderr, /alert not sent:/u, "the damage alert is raised");
    assert.equal(
      git("log", "-1", "--format=%s"),
      "file CORE.md: restore (correction)\n",
      "the restore is committed",
    );
    assert.equal(git("status", "--porcelain"), "", "nothing left uncommitted");
    assert.equal(
      vaultLog(paths.vault).filter((s) => s.includes("before turn")).length,
      0,
      "a clean CORE takes no snapshot commit",
    );
    assert.deepEqual(sessionCalls(fake), [
      "create",
      "reset wrun_fake_1",
      "create",
      "reset wrun_fake_2",
    ]);
  });
}

// Снимок и откат живут в истории vault: отказы git — громкие, ход не стартует или ночь
// кончается кодом 1, CORE в пустоту не откатывается.
test("a stuck .git/index.lock in the vault stops the night before the turn: no create, exit 1, CORE untouched", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  // Живой замок (свежий mtime): шов ждёт, огрызком не считает, коммит «before turn» не идёт.
  writeFileSync(join(paths.vault, ".git", "index.lock"), "");

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.deepEqual(prompts(fake), [], "the turn is not started");
  assert.match(
    run.stderr,
    /CORE\.md on disk does not match its snapshot commit .* the turn is not started/u,
  );
  assert.equal(readFileSync(core.path, "utf8"), core.text);
  assert.deepEqual(
    vaultLog(paths.vault),
    ["init-vault"],
    "no snapshot commit slipped through",
  );
});

test("a first night without CORE.md takes its snapshot without a commit: no pathspec failure, the turn runs", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  fake.onTurn = markDayDone(paths.vault);

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /pathspec|before turn/u);
  // Единственная запись ночи в истории — указатель; снимка «before turn» нет.
  assert.deepEqual(vaultLog(paths.vault), [
    "file CORE.md: pointer",
    "init-vault",
  ]);
});

test("a git failure that is not a missing path does not empty CORE: no restore, no restore commit, exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  const objects = join(paths.vault, ".git", "objects");
  fake.mode = "session-failed";
  // Ход дописал строку; объекты git стали нечитаемы — `git show` снимка отказывает не из-за пути.
  fake.onTurn = () => {
    appendLine(core.path);
    chmodSync(objects, 0o000);
  };

  const run = await runRollup(host, paths, "daily");
  chmodSync(objects, 0o755);

  assert.equal(run.code, 1, run.stderr);
  assert.notEqual(readFileSync(core.path, "utf8"), core.text, "not rewritten");
  assert.notEqual(readFileSync(core.path, "utf8"), "", "not emptied");
  assert.match(run.stderr, /git (ls-tree|show) [0-9a-f]+/u);
  assert.equal(
    vaultLog(paths.vault).some((s) => s.includes("restore")),
    false,
  );
});

test("a stuck index.lock after the turn: CORE is restored on disk, the restore commit fails, exit 1 without 'restored'", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  fake.mode = "session-failed";
  fake.onTurn = () => {
    appendLine(core.path);
    vaultGit(paths.vault, "add", "-A");
    vaultGit(paths.vault, "commit", "-q", "-m", "turn: half-edit");
    writeFileSync(join(paths.vault, ".git", "index.lock"), "");
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.equal(readFileSync(core.path, "utf8"), core.text, "restored on disk");
  assert.match(run.stderr, /CORE\.md restored on disk, commit failed:/u);
  assert.doesNotMatch(run.stderr, /is back to its pre-turn text/u);
  assert.equal(
    vaultLog(paths.vault)[0],
    "turn: half-edit",
    "no restore commit",
  );
});

// Сначала сказать владельцу, потом умереть: отказ коммита отката не глотает ни строку о потере,
// ни алерт; отказ коммита указателя — код 1.
test("a stuck index.lock after a turn that hollowed a section: the loss and the alert are reported before 'commit failed', exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  const done = markDayDone(paths.vault);
  fake.onTurn = (message) => {
    done(message);
    hollow(core.path);
    vaultGit(paths.vault, "add", "-A");
    vaultGit(paths.vault, "commit", "-q", "-m", "turn: hollow");
    writeFileSync(join(paths.vault, ".git", "index.lock"), "");
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  const lost = run.stderr.indexOf("CORE.md lost ## Предпочтения");
  const alert = run.stderr.indexOf("alert not sent:");
  const failed = run.stderr.indexOf("CORE.md restored on disk, commit failed:");
  assert.ok(lost >= 0 && alert > lost && failed > alert, run.stderr);
  assert.equal(readFileSync(core.path, "utf8"), core.text, "restored on disk");
});

test("a stuck index.lock before the pointer write: the pointer is on disk, its commit fails, exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  const yesterday = isoDaysAgo(1);
  writeRawDay(paths.vault, yesterday, "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault, "", isoDaysAgo(3));
  vaultGit(paths.vault, "add", "-A");
  vaultGit(paths.vault, "commit", "-q", "-m", "fixture");
  const done = markDayDone(paths.vault);
  fake.onTurn = (message) => {
    done(message);
    writeFileSync(join(paths.vault, ".git", "index.lock"), "");
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /CORE\.md pointer written on disk, commit failed:/u);
  assert.equal(
    readFileSync(core.path, "utf8"),
    setLastDayPointer(core.text, yesterday),
  );
  assert.equal(vaultLog(paths.vault)[0], "fixture", "no pointer commit");
});

test("a vault inside a foreign repository with no CORE.md: the turn runs, a damaging turn's restore cannot be committed, exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  // Репозиторий выше vault: шов коммитить не станет («репозиторий выше vault»), но ответит
  // ok:true, committed:false с причиной — это отказ, не «нечего коммитить».
  rmSync(join(paths.vault, ".git"), { force: true, recursive: true });
  vaultGit(paths.root, "init", "-q");
  vaultGit(paths.root, "commit", "-q", "--allow-empty", "-m", "outer");
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const corePath = join(paths.vault, "CORE.md");
  fake.mode = "session-failed";
  fake.onTurn = () =>
    writeFileSync(corePath, "# CORE\n\n## Предпочтения\n\n- новое\n");

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.equal(
    prompts(fake).length,
    1,
    "the turn did start: no CORE, nothing to snapshot",
  );
  assert.match(
    run.stderr,
    /CORE\.md restored on disk, commit failed: .*vault/u,
  );
  assert.equal(
    readFileSync(corePath, "utf8"),
    "",
    "restored to the empty pre-turn state on disk",
  );
});

test("the run stops right before the correction: no snapshot commit, CORE untouched, 'not started', exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  writeCore(
    paths.vault,
    `- ${"длинное предпочтение ".repeat(200)}`,
    isoDaysAgo(3),
  );
  vaultGit(paths.vault, "add", "-A");
  vaultGit(paths.vault, "commit", "-q", "-m", "fixture");
  fake.onTurn = markDayDone(paths.vault);
  let child: import("node:child_process").ChildProcess | undefined;
  // Сигнал — когда reset дневной сессии дошёл до сервера: ход дня закончен, коррекция впереди.
  fake.onReset = () => child?.kill("SIGTERM");

  const run = await runRollup(host, paths, "daily", {
    onChild: (spawned) => {
      child = spawned;
    },
  });

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /CORE\.md correction not started/u);
  assert.equal(prompts(fake).length, 1, "no correction turn");
  assert.equal(
    vaultLog(paths.vault).some((s) => s.includes("before turn")),
    false,
    "no snapshot commit for a correction that did not start",
  );
  assert.equal(vaultLog(paths.vault)[0], "file CORE.md: pointer");
});

// Пропавший объект коммита снимка: `git show <sha>:CORE.md` печатает ту же фразу, что при
// отсутствии пути; классификация идёт через ls-tree, и это отказ, а не «файла не было».
function dropObject(vault: string, sha: string): void {
  const dir = join(vault, ".git", "objects", sha.slice(0, 2));
  rmSync(join(dir, sha.slice(2)), { force: true });
  // Упакованных объектов у свежего репозитория нет: loose-файл — единственная копия.
  assert.equal(existsSync(join(dir, sha.slice(2))), false);
}

test("a snapshot commit whose object vanished: the day's restore is refused, CORE is not emptied, exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  vaultGit(paths.vault, "add", "-A");
  vaultGit(paths.vault, "commit", "-q", "-m", "fixture");
  const head = vaultGit(paths.vault, "rev-parse", "HEAD").trim();
  fake.mode = "session-failed";
  fake.onTurn = () => {
    appendLine(core.path);
    dropObject(paths.vault, head);
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /git ls-tree [0-9a-f]+/u);
  assert.notEqual(readFileSync(core.path, "utf8"), "", "not emptied");
  assert.match(readFileSync(core.path, "utf8"), /полуправка/u, "not rewritten");
});

test("a correction whose snapshot commit object vanished is not accepted: a bare '# CORE' does not pass, exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(
    paths.vault,
    `- ${"длинное предпочтение ".repeat(200)}`,
  );
  const done = markDayDone(paths.vault);
  fake.onTurn = (message) => {
    if (message.includes("Re-open")) {
      // Снимок коррекции — HEAD после указателя: его объект пропадает во время хода.
      dropObject(
        paths.vault,
        vaultGit(paths.vault, "rev-parse", "HEAD").trim(),
      );
      writeFileSync(core.path, "# CORE\n");
    } else done(message);
  };

  const run = await runRollup(host, paths, "daily");

  // Снимок прочитан один раз до хода, поэтому потеря названа и файл возвращён на диске; коммит
  // отката без объекта HEAD не проходит — коррекция не принята.
  assert.notEqual(run.code, 0, run.stderr);
  assert.match(run.stderr, /CORE\.md lost .*Указатели/u);
  assert.match(run.stderr, /restored on disk, commit failed/u);
  assert.doesNotMatch(run.stdout, /compressed/u);
  assert.notEqual(readFileSync(core.path, "utf8"), "# CORE\n");
});

test("a snapshot whose CORE blob vanished: ls-tree still lists the path, show fails — no restore into nothing, exit 1", async (t) => {
  const { fake, host, paths } = await fakeEve(t);
  writeRawDay(paths.vault, isoDaysAgo(1), "## 10:00 [text]\n\nдень\n");
  const core = writeCore(paths.vault);
  vaultGit(paths.vault, "add", "-A");
  vaultGit(paths.vault, "commit", "-q", "-m", "fixture");
  const blob = vaultGit(paths.vault, "rev-parse", "HEAD:CORE.md").trim();
  fake.mode = "session-failed";
  fake.onTurn = () => {
    appendLine(core.path);
    dropObject(paths.vault, blob);
  };

  const run = await runRollup(host, paths, "daily");

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /git show [0-9a-f]+:CORE\.md/u);
  assert.notEqual(readFileSync(core.path, "utf8"), "", "not emptied");
  assert.match(readFileSync(core.path, "utf8"), /полуправка/u, "not rewritten");
  assert.equal(
    vaultLog(paths.vault).some((s) => s.includes("restore")),
    false,
  );
});
