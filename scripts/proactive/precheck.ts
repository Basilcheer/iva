// Проверка перед ходом Watch (ADR-0020): источники без модели. Каждый источник отдаёт
// `{ items, error }`: не подключён — пусто без ошибки; подключён, но проверка не удалась —
// `error`, и тик заводит пункт `check:<источник>`. Ничего не пишет и никому не шлёт.
//
// Telegram — инструмент `list_chats` прокси юзербота (telegram-mcp f1a2d8e,
// telegram_mcp/tools/chats.py:449-578): `{"results":[…]}`, пусто — строка `No chats found…`.
// Почта — `gws`: список непрочитанных входящих без категорий, затем заголовки каждого письма;
// рассылка (`List-Unsubscribe`) пунктом не становится.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  MAIL_LIMIT,
  TELEGRAM_GROUPS_LIMIT,
  TELEGRAM_USERS_LIMIT,
  type Sender,
} from "#lib/proactive-config.ts";
import { childEnv, gwsBin } from "../lib/menu/gws-auth.ts";

/** Пункт Watch: ключ в `seen`, счётчик, кто прислал и (для `check:`) что сломалось. */
export type WatchItem = {
  readonly key: string;
  readonly unread: number;
  readonly from: Sender;
  readonly note?: string;
  /** Сбой регулярной задачи (T3): потолки и тумблер его не держат. */
  readonly failure?: boolean;
};

export type SourceResult = {
  readonly items: readonly WatchItem[];
  readonly error: string | null;
};

export type Source = {
  readonly name: string;
  /** Префикс ключей источника в `seen`. */
  readonly prefix: string;
  readonly check: () => Promise<SourceResult>;
};

const TELEGRAM_TIMEOUT_MS = 10_000;
const MAIL_TIMEOUT_MS = 20_000;
const NOT_CONNECTED: SourceResult = { items: [], error: null };

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** JSON или undefined: что делать с не-JSON, решает вызывающий. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ── Telegram ─────────────────────────────────────────────────────────────────────────────

type ChatRecord = Readonly<Record<string, unknown>>;

export type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/** Ответ `list_chats`: записи или ошибка; строка `No chats found…` — пусто. */
export function parseChats(text: string): ChatRecord[] {
  if (text.startsWith("No chats found")) return [];
  const results = (parseJson(text) as { results?: unknown } | null)?.results;
  if (!Array.isArray(results))
    throw new Error(
      `list_chats answered not {"results":[…]}: ${text.slice(0, 200)}`,
    );
  return results.filter(
    (row): row is ChatRecord => typeof row === "object" && row !== null,
  );
}

const count = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Запись → пункт: личный чат по `unread` (+1 за `unread_mark`), группа — по упоминаниям. */
function chatItem(row: ChatRecord, botId: string): WatchItem | null {
  const id = row.chat_id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) === botId
  )
    return null;
  const unread =
    row.type === "User"
      ? count(row.unread) + (row.unread_mark === true ? 1 : 0)
      : count(row.unread_mentions);
  const from = {
    username: text(row.username),
    name: text(row.name ?? row.title),
  };
  return unread === 0 ? null : { key: `tg:${id}`, unread, from };
}

/** Вызов инструмента прокси по streamable-http с bearer; срок на соединение и на вызов. */
export function proxyCallTool(
  url: string,
  token: string,
  timeoutMs = TELEGRAM_TIMEOUT_MS,
): CallTool {
  return async (name, args) => {
    const client = new Client({ name: "iva-watch", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const timeout = { timeout: timeoutMs };
    try {
      await client.connect(transport, timeout);
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        timeout,
      );
      const parts = Array.isArray(result.content) ? result.content : [];
      const first = (parts as Array<{ text?: unknown }>).find(
        (part) => typeof part.text === "string",
      );
      if (typeof first?.text !== "string")
        throw new Error(`${name} answered without text`);
      return first.text;
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}

function proxyToken(env: NodeJS.ProcessEnv, dataDir: string): string {
  if (env.TELEGRAM_MCP_TOKEN) return env.TELEGRAM_MCP_TOKEN;
  try {
    return readFileSync(join(dataDir, "telegram-userbot.token"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Оба вызова `list_chats` (личные, группы) → пункты без повторов. */
async function listChats(
  call: CallTool,
  botId: string,
  log: (line: string) => void,
): Promise<WatchItem[]> {
  const items = new Map<string, WatchItem>();
  for (const [chatType, limit] of [
    ["user", TELEGRAM_USERS_LIMIT],
    ["group", TELEGRAM_GROUPS_LIMIT],
  ] as const) {
    const rows = parseChats(
      await call("list_chats", {
        chat_type: chatType,
        unread_only: true,
        unmuted_only: true,
        archived: false,
        limit,
      }),
    );
    if (rows.length >= limit)
      log(`proactive: telegram ${chatType} chats hit the limit ${limit}`);
    for (const item of rows.map((row) => chatItem(row, botId)))
      if (item) items.set(item.key, item);
  }
  return [...items.values()];
}

/** Личные чаты и группы с упоминаниями; нет токена прокси — не подключён. */
export function telegramSource(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  callTool?: CallTool,
  log: (line: string) => void = console.log,
): Source {
  const check = async (): Promise<SourceResult> => {
    const token = proxyToken(env, dataDir);
    if (token === "" && callTool === undefined) return NOT_CONNECTED;
    const port = env.TELEGRAM_MCP_PORT || "8724";
    const call =
      callTool ?? proxyCallTool(`http://127.0.0.1:${port}/mcp`, token);
    // Чат самого бота Ивы — не пропущенное: id бота стоит в начале его токена.
    const botId = String(env.TELEGRAM_BOT_TOKEN ?? "").split(":")[0] ?? "";
    try {
      return { items: await listChats(call, botId, log), error: null };
    } catch (error) {
      return { items: [], error: message(error) };
    }
  };
  return { name: "telegram", prefix: "tg:", check };
}

// ── Почта ────────────────────────────────────────────────────────────────────────────────

export const MAIL_QUERY =
  "is:unread in:inbox -category:promotions -category:social -category:forums -category:updates";

/** Исход `gws`: код выхода (2 — не авторизован), нет бинаря или срок вышел; и stdout. */
export type GwsRun = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ code: number | "missing" | "timeout"; stdout: string }>;

function gwsCode(error: (Error & { code?: unknown; killed?: boolean }) | null) {
  if (error === null) return 0;
  if (error.code === "ENOENT") return "missing";
  if (error.killed === true) return "timeout";
  return typeof error.code === "number" ? error.code : 1;
}

const runGws: GwsRun = (args, timeoutMs) =>
  new Promise((resolve) => {
    const options = { timeout: timeoutMs, env: childEnv(), maxBuffer: 4 << 20 };
    execFile(gwsBin(), [...args], options, (error, stdout) =>
      resolve({ code: gwsCode(error), stdout: String(stdout) }),
    );
  });

/** Один вызов `gws gmail users messages …` с JSON-ответом; не подключён — null. */
async function gwsJson(
  run: GwsRun,
  params: Record<string, unknown>,
  deadline: number,
): Promise<Record<string, unknown> | null> {
  const method = "id" in params ? "get" : "list";
  const { code, stdout } = await run(
    ["gmail", "users", "messages", method, "--params", JSON.stringify(params)],
    Math.max(1, deadline - Date.now()),
  );
  if (code === "missing" || code === 2) return null;
  if (code === "timeout")
    throw new Error(`gws timed out after ${MAIL_TIMEOUT_MS} ms`);
  if (code !== 0) throw new Error(`gws ${method} exited ${code}`);
  const parsed = parseJson(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`gws ${method} answered not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** `Имя <адрес>` → имя и адрес из скобок; голый адрес — он сам. */
export function senderOf(from: string): Sender {
  const bare = /^\S+@\S+$/u.test(from.trim()) ? from.trim() : undefined;
  const email = /<([^<>\s]+@[^<>\s]+)>/u.exec(from)?.[1] ?? bare;
  const name = text(
    from
      .replace(/<[^<>]*>/u, "")
      .replace(/"/gu, "")
      .trim(),
  );
  return { email, name: name === bare ? undefined : name };
}

function header(message: Record<string, unknown> | null, wanted: string) {
  const headers = (message?.payload as { headers?: unknown } | undefined)
    ?.headers;
  const found = (Array.isArray(headers) ? headers : []).find(
    (h: { name?: unknown }) =>
      typeof h.name === "string" &&
      h.name.toLowerCase() === wanted.toLowerCase(),
  ) as { value?: unknown } | undefined;
  return typeof found?.value === "string" ? found.value : null;
}

/** Непрочитанные входящие без категорий и рассылок, не больше MAIL_LIMIT; срок 20 с на всё. */
export function mailSource(run: GwsRun = runGws): Source {
  const check = async (): Promise<SourceResult> => {
    const deadline = Date.now() + MAIL_TIMEOUT_MS;
    try {
      const list = await gwsJson(
        run,
        { userId: "me", q: MAIL_QUERY, maxResults: MAIL_LIMIT },
        deadline,
      );
      if (list === null) return NOT_CONNECTED;
      const ids = (Array.isArray(list.messages) ? list.messages : [])
        .map((m: { id?: unknown }) => m.id)
        .filter(
          (id): id is string => typeof id === "string" && /^[\w-]+$/u.test(id),
        )
        .slice(0, MAIL_LIMIT);
      const headers = ["From", "List-Unsubscribe"];
      const metadata = { format: "metadata", metadataHeaders: headers };
      const messages = await Promise.all(
        ids.map((id) =>
          gwsJson(run, { userId: "me", id, ...metadata }, deadline),
        ),
      );
      const items: WatchItem[] = [];
      for (const [index, id] of ids.entries()) {
        const m = messages[index] ?? null;
        const from = senderOf(header(m, "From") ?? "");
        if (m !== null && header(m, "List-Unsubscribe") === null)
          items.push({ key: `mail:${id}`, unread: 1, from });
      }
      return { items, error: null };
    } catch (error) {
      return { items: [], error: message(error) };
    }
  };
  return { name: "mail", prefix: "mail:", check };
}
