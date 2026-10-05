/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Черновик Insight привязан к сообщению (ADR-0022, пересмотр 06.10.2026): тик записал отпечаток
// черновика в `insight.tree` при отправке, и `iva plugin add` без человека у терминала по папке
// этого черновика ставит его, только если staged-копия совпала с отпечатком. Команда идёт по
// настоящему стору во временном доме; ход модели не нужен — `bash` модели зовёт ровно это.
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { PLUGIN_SCHEMA_URL, pluginTreeDigest } from "#lib/plugin-reader.ts";
import { pluginRoot, readPluginsState } from "#lib/plugin-store.ts";
import { initialState } from "../proactive/state.ts";
import { createPluginCommands } from "./plugin.ts";
import { createCliRuntime } from "./runtime.ts";

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };
const homes: string[] = [];
after(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** Дом установки с черновиком `count-receipts` (один скилл, без кода — `add` его пустит). */
function home(): { root: string; data: string; draft: string } {
  const root = mkdtempSync(join(tmpdir(), "iva-plugin-insight-"));
  homes.push(root);
  const data = join(root, "data");
  const draft = join(data, "custom/plugin-drafts/count-receipts");
  write(
    draft,
    "plugin.json",
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name: "count-receipts",
      version: "1.0.0",
    }),
  );
  write(
    draft,
    "skills/count-receipts/SKILL.md",
    "---\nname: count-receipts\ndescription: Count the receipts.\n---\n\nBody.\n",
  );
  return { root, data, draft };
}

/** Записанный тиком Insight: черновик и его отпечаток в минуту отправки. */
async function insightSent(
  data: string,
  draft: string,
  tree?: string,
): Promise<void> {
  const fingerprint =
    tree ??
    (await pluginTreeDigest(join(data, "custom/plugin-drafts", draft))).slice(
      0,
      12,
    );
  writeFileSync(
    join(data, "proactive.json"),
    JSON.stringify({
      ...initialState(Date.UTC(2026, 9, 5)),
      insight: {
        day: "2026-10-05",
        draft,
        misses: 0,
        pausedUntilMs: 0,
        tree: fingerprint,
      },
    }),
  );
}

function commands(root: string, interactive: boolean) {
  const events: Array<[string, string]> = [];
  const runtime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    hasSystemd: () => false,
    ok: (message: string) => events.push(["ok", message]),
    warn: (message: string) => events.push(["warn", message]),
    bad: (message: string) => events.push(["bad", message]),
    step: (message: string) => events.push(["step", message]),
    readEnv: () => ({}),
  };
  const { cmdPlugin } = createPluginCommands(runtime, {
    now: () => new Date("2026-10-05T12:00:00.000Z"),
    log: () => {},
    translate: (en) => en,
    cwd: () => root,
    interactive: () => interactive,
  });
  return { cmdPlugin, events };
}

const installed = async (data: string) =>
  (await readPluginsState(data)).plugins.map((entry) => entry.name);

/** Что лежит в data/custom/plugins: ни плагина, ни недоделанного staging. */
const store = (data: string) => {
  const dir = join(data, "custom/plugins");
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name !== "plugins.json")
    : [];
};

test("not a TTY: the draft edited after the Insight message is refused as out of date, plugins/ untouched", async () => {
  const { root, data, draft } = home();
  await insightSent(data, "count-receipts");
  write(
    draft,
    "skills/count-receipts/SKILL.md",
    "---\nname: count-receipts\ndescription: Something else.\n---\n",
  );
  const { cmdPlugin } = commands(root, false);
  await assert.rejects(
    cmdPlugin(["add", draft]),
    /the proposal is out of date/u,
  );
  assert.deepEqual(await installed(data), []);
  assert.deepEqual(store(data), []);
});

test("not a TTY: the draft as it was in the message is installed, by its absolute path and through ./", async () => {
  const { root, data, draft } = home();
  await insightSent(data, "count-receipts");
  await commands(root, false).cmdPlugin(["add", draft]);
  assert.deepEqual(await installed(data), ["count-receipts"]);
  assert.ok(
    existsSync(join(pluginRoot(data, "count-receipts"), "plugin.json")),
  );

  // Тот же черновик относительным путём от shell: сверка по realpath, а не по строке.
  const second = home();
  await insightSent(second.data, "count-receipts", "000000000000");
  await assert.rejects(
    commands(second.root, false).cmdPlugin([
      "add",
      "./data/custom/plugin-drafts/count-receipts",
    ]),
    /the proposal is out of date/u,
  );
});

test("the owner at the terminal installs the edited draft without the check", async () => {
  const { root, data, draft } = home();
  await insightSent(data, "count-receipts", "000000000000");
  const { cmdPlugin } = commands(root, true);
  await cmdPlugin(["add", draft]);
  assert.deepEqual(await installed(data), ["count-receipts"]);
});

test("not a TTY: another folder, another draft name, no tree or no proactive.json — no check", async () => {
  // Другая папка с тем же содержимым: сверяется только черновик последнего Insight.
  const other = home();
  const copy = join(other.root, "elsewhere/count-receipts");
  await insightSent(other.data, "count-receipts", "000000000000");
  write(
    copy,
    "plugin.json",
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name: "count-receipts",
      version: "1.0.0",
    }),
  );
  write(
    copy,
    "skills/count-receipts/SKILL.md",
    "---\nname: count-receipts\ndescription: Count.\n---\n",
  );
  await commands(other.root, false).cmdPlugin(["add", copy]);
  assert.deepEqual(await installed(other.data), ["count-receipts"]);

  const renamed = home();
  await insightSent(renamed.data, "other-draft", "000000000000");
  await commands(renamed.root, false).cmdPlugin(["add", renamed.draft]);
  assert.deepEqual(await installed(renamed.data), ["count-receipts"]);

  const untreed = home();
  writeFileSync(
    join(untreed.data, "proactive.json"),
    JSON.stringify({
      ...initialState(0),
      insight: {
        day: "2026-10-05",
        draft: "count-receipts",
        misses: 0,
        pausedUntilMs: 0,
      },
    }),
  );
  await commands(untreed.root, false).cmdPlugin(["add", untreed.draft]);
  assert.deepEqual(await installed(untreed.data), ["count-receipts"]);

  const fresh = home();
  await commands(fresh.root, false).cmdPlugin(["add", fresh.draft]);
  assert.deepEqual(await installed(fresh.data), ["count-receipts"]);
});

test("not a TTY: a damaged proactive.json is a warning and the install goes on without the check", async () => {
  const { root, data, draft } = home();
  writeFileSync(join(data, "proactive.json"), "{ not json");
  const { cmdPlugin, events } = commands(root, false);
  await cmdPlugin(["add", draft]);
  assert.deepEqual(await installed(data), ["count-receipts"]);
  assert.ok(
    events.some(
      ([kind, line]) =>
        kind === "warn" &&
        /proactive\.json is not readable .*installing without comparing/u.test(
          line,
        ),
    ),
    JSON.stringify(events),
  );
});
