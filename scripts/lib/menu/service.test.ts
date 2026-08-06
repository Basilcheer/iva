/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and injected service doubles preserve asynchronous boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import service, {
  commandSpec,
  type ExecFileImplementation,
  type MenuServiceContext,
  type MenuServiceState,
  type MenuServiceView,
} from "./service.ts";
import root from "./root.ts";
import {
  LOADERS,
  currentRun,
  resetForTests,
  type RunOptions,
} from "./svc-run.ts";
import { acquireUpdateLock, releaseUpdateLock } from "../update-safety.ts";

const { SCREENS } = (await import("./index.ts")) as {
  SCREENS: Record<string, unknown>;
};

type TestState = MenuServiceState & {
  flow: "menu";
  page: number;
  awaitText: null;
  data: Record<string, unknown>;
  _last?: MenuServiceView;
};
type TelegramBody = Record<string, unknown> & {
  text?: string;
  entities?: Array<{ custom_emoji_id?: string }>;
  reply_markup?: unknown;
};
type TelegramCall = { method: string; body: TelegramBody };
type Harness = {
  ctx: MenuServiceContext;
  rendered: MenuServiceView[];
  tgCalls: TelegramCall[];
  st: TestState | null;
};
type TestDeps = Partial<MenuServiceContext["deps"]>;

// стенд как в menu-screens.test.ts + захват прямых tg-вызовов раннера
function makeCtx({
  lang = "ru",
  deps = {},
}: { lang?: string; deps?: TestDeps } = {}): Harness {
  const rendered: MenuServiceView[] = [];
  const tgCalls: TelegramCall[] = [];
  let state: TestState | null = null;
  const flows = {
    screen: async (
      st: MenuServiceState,
      text: string,
      rows: MenuServiceView["rows"],
    ) => {
      const testState = st as TestState;
      testState.msgId ??= 1;
      testState._last = { text, rows };
      rendered.push({ text, rows });
    },
    get: () => state,
    touch: () => {},
  };
  const ctx: MenuServiceContext = {
    tg: async (method, body) => {
      tgCalls.push({ method, body });
      return { ok: true, result: {} };
    },
    deps: { root: "", envPath: "", dataDir: "", ...deps },
    flows,
    tr: (en: string, ru: string) => (lang === "ru" ? ru : en),
    btn: (text: string, data: string) => ({ text, callback_data: data }),
    backRow: () => [{ text: "‹ Назад", callback_data: "iva_menu:r:o" }],
    show: async (st: MenuServiceState, sid: string) => {
      st.screen = sid;
      const v = await service.render(st, ctx);
      await flows.screen(st, v.text, v.rows);
    },
  };
  return {
    ctx,
    rendered,
    tgCalls,
    get st() {
      return state;
    },
    set st(next: TestState | null) {
      state = next;
    },
  };
}

const newState = (over: Partial<TestState> = {}): TestState => ({
  flow: "menu",
  chatId: 10,
  userId: "20",
  screen: "svc",
  page: 0,
  awaitText: null,
  data: {},
  msgId: 1,
  ...over,
});

const waitFor = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
};

const fastRun = {
  tickMs: 15,
  timeoutMs: 5000,
  pollMs: 5,
} satisfies Partial<RunOptions>;

test("svc зарегистрирован в движке, root ведёт на него, Закрыть в своём ряду", () => {
  assert.equal(SCREENS.svc, service);
  const view = root.render(newState({ screen: "r" }), makeCtx().ctx);
  const flat = view.rows.flat();
  assert.ok(flat.some((b) => b.callback_data === "iva_menu:svc:o"));
  const closeRow = view.rows.find((r) =>
    r.some((b) => b.callback_data === "iva_menu:r:x"),
  );
  assert.ok(closeRow);
  assert.equal(closeRow.length, 1);
});

test("render idle: четыре команды и Назад, ru/en", async () => {
  resetForTests();
  for (const lang of ["ru", "en"]) {
    const h = makeCtx({ lang });
    const st = newState();
    h.st = st;
    const view = await service.render(st, h.ctx);
    const data = view.rows.flat().map((b) => b.callback_data);
    for (const cb of [
      "iva_menu:svc:c:doc",
      "iva_menu:svc:c:cln",
      "iva_menu:svc:c:mem",
      "iva_menu:svc:up",
    ])
      assert.ok(data.includes(cb), `${lang}: ${cb}`);
    assert.match(view.text, lang === "ru" ? /Обслуживание/ : /Maintenance/);
  }
});

test("подтверждение: c:<cmd> рисует описание и ▶ go:<cmd>", async () => {
  resetForTests();
  const h = makeCtx();
  const st = newState();
  h.st = st;
  for (const cmd of ["doc", "cln", "mem"]) {
    await service.on("c", [cmd], st, h.ctx);
    assert.ok(st._last);
    const data = st._last.rows.flat().map((b) => b.callback_data);
    assert.ok(data.includes(`iva_menu:svc:go:${cmd}`));
    assert.ok(data.includes("iva_menu:svc:o")); // Назад к списку
  }
});

test("up: хендофф в deps.handleUpdateCheck с chatId", async () => {
  resetForTests();
  let called: string | number | null = null;
  const h = makeCtx({
    deps: {
      handleUpdateCheck: (chatId) => {
        called = chatId;
      },
    },
  });
  const st = newState();
  h.st = st;
  await service.on("up", [], st, h.ctx);
  assert.equal(called, 10);
});

// Регрессия 0.3.2: кнопка спавнила cleanup.py по пути ВНУТРИ vault'а, куда его клал синк.
// Юзеры с 0.3.0 прыжком на 0.3.2 получали «Failed to spawn … (os error 2)». Скрипт обязан
// браться из репо и реально существовать, а vault остаётся только рабочим каталогом.
test("cln: cleanup.py берётся из репо, cwd — vault", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const h = makeCtx({
    deps: { root: repoRoot, envPath: join(dataDir, ".env") },
  });
  const spec = await commandSpec("cln", h.ctx);
  assert.equal(spec.kind, "proc");
  assert.deepEqual(spec.argv.slice(0, 2), ["uv", "run"]);
  assert.equal(spec.argv[2], join(repoRoot, "scripts/autograph/cleanup.py"));
  assert.ok(existsSync(spec.argv[2]), `нет скрипта: ${spec.argv[2]}`);
  assert.deepEqual(spec.argv.slice(3), [".", "--apply"]);
  assert.equal(spec.cwd, join(repoRoot, "vault"));
});

test("go:doc: прогресс с 🟥-entity, финал ✅ с кнопкой Назад", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/nonexistent",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      svcSpec: () => ({
        kind: "proc",
        argv: [process.execPath, "-e", "console.log('шаг ок')"],
      }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["doc"], st, h.ctx);
  await waitFor(() => currentRun()?.status === "done");
  await waitFor(() => h.tgCalls.some((c) => /✅/.test(c.body.text || "")));
  const rich = h.tgCalls.find((c) => c.body.entities);
  assert.ok(rich);
  assert.ok(rich.body.entities);
  assert.equal(rich.body.entities[0].custom_emoji_id, LOADERS.doc.id);
  const final = h.tgCalls.filter((c) => /✅/.test(c.body.text || "")).at(-1);
  assert.ok(final);
  assert.ok(final.body.text);
  assert.match(final.body.text, /Диагностика пройдена/);
  assert.ok(JSON.stringify(final.body.reply_markup).includes("iva_menu:svc:o"));
});

test("go:cln: сводка парсит финальную строку cleanup", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/nonexistent",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      // Строка ДОСЛОВНО как её печатает scripts/autograph/cleanup.py (режим — applied).
      svcSpec: () => ({
        kind: "proc",
        argv: [
          process.execPath,
          "-e",
          "console.log('cleanup (applied): 3 file(s), 224,000,000 bytes of bug garbage')",
        ],
      }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["cln"], st, h.ctx);
  await waitFor(() =>
    h.tgCalls.some(
      (c) => /Чистка/.test(c.body.text || "") && /✅/.test(c.body.text || ""),
    ),
  );
  const final = h.tgCalls.filter((c) => /✅/.test(c.body.text || "")).at(-1);
  assert.ok(final);
  assert.ok(final.body.text);
  assert.match(final.body.text, /3 файл/);
  assert.match(final.body.text, /224(\.0)? МБ/);
});

test("go:mem: юнит через systemctl, финал «Цикл памяти пройден»", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const active = ["activating", "inactive"];
  const execFileImpl: ExecFileImplementation = (
    cmd,
    args,
    _options,
    callback,
  ) => {
    const a = args.join(" ");
    if (a.includes("start")) return callback(null, "", "");
    if (a.includes("is-active"))
      return callback(null, active.shift() ?? "inactive", "");
    if (cmd === "journalctl") return callback(null, "done\n", "");
    return callback(null, "", "");
  };
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/x",
      envPath: join(dataDir, ".env"),
      svcRun: { ...fastRun, execFileImpl },
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["mem"], st, h.ctx);
  await waitFor(() =>
    h.tgCalls.some((c) => /Цикл памяти пройден/.test(c.body.text || "")),
  );
});

test("busy-гейт: второй go при running — экран «Уже идёт», без второго процесса", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/x",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      svcSpec: () => ({
        kind: "proc",
        argv: [process.execPath, "-e", "setTimeout(()=>{}, 2000)"],
      }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["doc"], st, h.ctx);
  await waitFor(() => currentRun()?.status === "running");
  const first = currentRun();
  await service.on("go", ["cln"], st, h.ctx);
  assert.equal(currentRun(), first); // новый не стартовал
  assert.ok(st._last);
  assert.match(st._last.text, /Уже идёт|идёт/i);
  // отмена через ab
  await service.on("ab", [], st, h.ctx);
  await waitFor(() => currentRun()?.status === "cancelled");
  await waitFor(() =>
    h.tgCalls.some((c) => /Прервано/.test(c.body.text || "")),
  );
});

test("update-lock: занят — go:doc не стартует, текст про обновление", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const lock = acquireUpdateLock(dataDir, "test-hold");
  assert.ok(lock.ok);
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/x",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      svcSpec: () => ({ kind: "proc", argv: [process.execPath, "-e", "0"] }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["doc"], st, h.ctx);
  assert.equal(currentRun(), null);
  assert.ok(st._last);
  assert.match(st._last.text, /обновлени/i);
  releaseUpdateLock(lock);
});
