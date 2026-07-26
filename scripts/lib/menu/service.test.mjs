import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import service, { commandSpec } from "./service.mjs";
import root from "./root.mjs";
import { SCREENS } from "./index.mjs";
import { LOADERS, currentRun, resetForTests } from "./svc-run.mjs";
import { acquireUpdateLock, releaseUpdateLock } from "../update-safety.mjs";

// стенд как в menu-screens.test.mjs + захват прямых tg-вызовов раннера
function makeCtx({ lang = "ru", deps = {} } = {}) {
  const rendered = [];
  const tgCalls = [];
  const flows = {
    screen: async (st, text, rows) => { st.msgId ??= 1; st._last = { text, rows }; rendered.push({ text, rows }); },
    end: async (st, text, rows) => { st._last = { text, rows }; rendered.push({ text, rows }); },
    get: () => harness.st,
    touch: () => {},
  };
  const ctx = {
    tg: async (method, body) => { tgCalls.push({ method, body }); return { ok: true, result: {} }; },
    deps, flows, lang,
    tr: (en, ru) => (lang === "ru" ? ru : en),
    getLang: () => lang,
    btn: (text, data) => ({ text, callback_data: data }),
    backRow: () => [{ text: "‹ Назад", callback_data: "iva_menu:r:o" }],
    show: async (st, sid) => { st.screen = sid; const v = await service.render(st, ctx); if (v) await flows.screen(st, v.text, v.rows); },
  };
  const harness = { ctx, flows, rendered, tgCalls, st: null };
  return harness;
}

const newState = (over = {}) => ({
  flow: "menu", chatId: 10, userId: "20", screen: "svc", page: 0, awaitText: null, data: {}, msgId: 1, ...over,
});

const waitFor = async (fn, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("waitFor timeout");
};

const fastRun = { tickMs: 15, timeoutMs: 5000, pollMs: 5 };

test("svc зарегистрирован в движке, root ведёт на него, Закрыть в своём ряду", () => {
  assert.equal(SCREENS.svc, service);
  const view = root.render(newState({ screen: "r" }), makeCtx().ctx);
  const flat = view.rows.flat();
  assert.ok(flat.some((b) => b.callback_data === "iva_menu:svc:o"));
  const closeRow = view.rows.find((r) => r.some((b) => b.callback_data === "iva_menu:r:x"));
  assert.equal(closeRow.length, 1);
});

test("render idle: четыре команды и Назад, ru/en", async () => {
  resetForTests();
  for (const lang of ["ru", "en"]) {
    const h = makeCtx({ lang });
    const st = newState(); h.st = st;
    const view = await service.render(st, h.ctx);
    const data = view.rows.flat().map((b) => b.callback_data);
    for (const cb of ["iva_menu:svc:c:doc", "iva_menu:svc:c:cln", "iva_menu:svc:c:mem", "iva_menu:svc:up"])
      assert.ok(data.includes(cb), `${lang}: ${cb}`);
    assert.match(view.text, lang === "ru" ? /Обслуживание/ : /Maintenance/);
  }
});

test("подтверждение: c:<cmd> рисует описание и ▶ go:<cmd>", async () => {
  resetForTests();
  const h = makeCtx();
  const st = newState(); h.st = st;
  for (const cmd of ["doc", "cln", "mem"]) {
    await service.on("c", [cmd], st, h.ctx);
    const data = st._last.rows.flat().map((b) => b.callback_data);
    assert.ok(data.includes(`iva_menu:svc:go:${cmd}`));
    assert.ok(data.includes("iva_menu:svc:o")); // Назад к списку
  }
});

test("up: хендофф в deps.handleUpdateCheck с chatId", async () => {
  resetForTests();
  let called = null;
  const h = makeCtx({ deps: { handleUpdateCheck: (chatId) => { called = chatId; } } });
  const st = newState(); h.st = st;
  await service.on("up", [], st, h.ctx);
  assert.equal(called, 10);
});

// Регрессия 0.3.2: кнопка спавнила cleanup.py по пути ВНУТРИ vault'а, куда его клал синк.
// Юзеры с 0.3.0 прыжком на 0.3.2 получали «Failed to spawn … (os error 2)». Скрипт обязан
// браться из репо и реально существовать, а vault остаётся только рабочим каталогом.
test("cln: cleanup.py берётся из репо, cwd — vault", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const h = makeCtx({ deps: { root: repoRoot, envPath: join(dataDir, ".env") } });
  const spec = await commandSpec("cln", h.ctx);
  assert.deepEqual(spec.argv.slice(0, 2), ["uv", "run"]);
  assert.equal(spec.argv[2], join(repoRoot, "scripts/autograph/cleanup.py"));
  assert.ok(existsSync(spec.argv[2]), `нет скрипта: ${spec.argv[2]}`);
  assert.deepEqual(spec.argv.slice(3), [".", "--apply"]);
  assert.equal(spec.cwd, join(repoRoot, "vault"));
});

test("go:doc: прогресс с 🟥-entity, финал ✅ с кнопкой Назад", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const h = makeCtx({ deps: {
    dataDir, root: "/nonexistent", envPath: join(dataDir, ".env"),
    svcRun: fastRun,
    svcSpec: () => ({ kind: "proc", argv: [process.execPath, "-e", "console.log('шаг ок')"] }),
  }});
  const st = newState(); h.st = st;
  await service.on("go", ["doc"], st, h.ctx);
  await waitFor(() => currentRun()?.status === "done");
  await waitFor(() => h.tgCalls.some((c) => /✅/.test(c.body.text || "")));
  const rich = h.tgCalls.find((c) => c.body.entities);
  assert.equal(rich.body.entities[0].custom_emoji_id, LOADERS.doc.id);
  const final = h.tgCalls.filter((c) => /✅/.test(c.body.text || "")).at(-1);
  assert.match(final.body.text, /Диагностика пройдена/);
  assert.ok(JSON.stringify(final.body.reply_markup).includes("iva_menu:svc:o"));
});

test("go:cln: сводка парсит финальную строку cleanup", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const h = makeCtx({ deps: {
    dataDir, root: "/nonexistent", envPath: join(dataDir, ".env"),
    svcRun: fastRun,
    svcSpec: () => ({ kind: "proc", argv: [process.execPath, "-e",
      "console.log('cleanup (apply): 3 file(s), 224,000,000 bytes of bug garbage removed')"] }),
  }});
  const st = newState(); h.st = st;
  await service.on("go", ["cln"], st, h.ctx);
  await waitFor(() => h.tgCalls.some((c) => /Чистка/.test(c.body.text || "") && /✅/.test(c.body.text)));
  const final = h.tgCalls.filter((c) => /✅/.test(c.body.text || "")).at(-1);
  assert.match(final.body.text, /3 файл/);
  assert.match(final.body.text, /224(\.0)? МБ/);
});

test("go:mem: юнит через systemctl, финал «Цикл памяти пройден»", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const active = ["activating", "inactive"];
  const execFileImpl = (cmd, args, o, cb) => {
    const a = args.join(" ");
    if (a.includes("start")) return cb(null, "");
    if (a.includes("is-active")) return cb(null, active.shift() ?? "inactive");
    if (cmd === "journalctl") return cb(null, "done\n");
    return cb(null, "");
  };
  const h = makeCtx({ deps: { dataDir, root: "/x", envPath: join(dataDir, ".env"), svcRun: { ...fastRun, execFileImpl } } });
  const st = newState(); h.st = st;
  await service.on("go", ["mem"], st, h.ctx);
  await waitFor(() => h.tgCalls.some((c) => /Цикл памяти пройден/.test(c.body.text || "")));
});

test("busy-гейт: второй go при running — экран «Уже идёт», без второго процесса", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const h = makeCtx({ deps: {
    dataDir, root: "/x", envPath: join(dataDir, ".env"), svcRun: fastRun,
    svcSpec: () => ({ kind: "proc", argv: [process.execPath, "-e", "setTimeout(()=>{}, 2000)"] }),
  }});
  const st = newState(); h.st = st;
  await service.on("go", ["doc"], st, h.ctx);
  await waitFor(() => currentRun()?.status === "running");
  const first = currentRun();
  await service.on("go", ["cln"], st, h.ctx);
  assert.equal(currentRun(), first); // новый не стартовал
  assert.match(st._last.text, /Уже идёт|идёт/i);
  // отмена через ab
  await service.on("ab", [], st, h.ctx);
  await waitFor(() => currentRun()?.status === "cancelled");
  await waitFor(() => h.tgCalls.some((c) => /Прервано/.test(c.body.text || "")));
});

test("update-lock: занят — go:doc не стартует, текст про обновление", async () => {
  resetForTests();
  const dataDir = mkdtempSync(join(tmpdir(), "iva-data-"));
  const lock = acquireUpdateLock(dataDir, "test-hold");
  assert.ok(lock.ok);
  const h = makeCtx({ deps: {
    dataDir, root: "/x", envPath: join(dataDir, ".env"), svcRun: fastRun,
    svcSpec: () => ({ kind: "proc", argv: [process.execPath, "-e", "0"] }),
  }});
  const st = newState(); h.st = st;
  await service.on("go", ["doc"], st, h.ctx);
  assert.equal(currentRun(), null);
  assert.match(st._last.text, /обновлени/i);
  releaseUpdateLock(lock);
});
