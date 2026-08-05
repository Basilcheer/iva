# «🛠 Обслуживание» в /menu — план имплементации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Экран «🛠 Обслуживание» в `/menu`: доктор, чистка vault, ночной цикл памяти, обновление — с живым прогрессом анимированными custom emoji и итоговыми сводками.

**Architecture:** Новый экран `svc` (вьюхи+копирайт) поверх нового раннера `svc-run.mjs` (механика: spawn-процессы в cgroup моста, oneshot-юнит через `systemctl --no-block`+поллинг, редактирование сообщения custom-emoji-лоадером с даунгрейдом без Premium). Update — хендофф в существующий `/update`-флоу.

**Tech Stack:** Node 24 (ESM .mjs), node:test, Telegram Bot API, systemd user units.

Спека: `notes/specs/2026-07-25-menu-service-design.md`.

## Global Constraints

- **Коммиты: НИКАКИХ упоминаний Claude/Anthropic/AI** (правило CLAUDE.md репо, без исключений).
- Ни одной module-level const с переведённой строкой — все подписи через `ctx.tr` в render/on (id эмодзи, enum'ы — можно).
- callback_data: ASCII, `iva_menu:svc:<verb>[:<arg>]`, ≤64 байта.
- Единственный getUpdates-цикл моста не блокировать: никаких sync-ожиданий >1.5с в render/on.
- Редактирование прогресса: не чаще раза в 3с, идентичный payload не отправлять.
- Версия релиза: `0.3.2`. Пуш — в конце, с тегом.
- Тесты: `node --test scripts/lib/menu/` — все зелёные перед каждым коммитом.

---

### Task 1: Раннер `svc-run.mjs` — механика процессов, юнита и прогресса

**Files:**

- Create: `scripts/lib/menu/svc-run.mjs`
- Test: `scripts/lib/menu/svc-run.test.mjs`

**Interfaces (Produces):**

- `LOADERS = { doc:{alt:"🟥",id:"5255894270597941229",fallback:"◇"}, cln:{alt:"🟨",id:"5255975857796695002",fallback:"◇"}, mem:{alt:"🟪",id:"5256218768262056531",fallback:"◇"} }`
- `TIMEOUT_MS = { doc: 600_000, cln: 1_800_000, mem: 3_600_000 }`
- `stripAnsi(s: string): string`
- `elapsed(run): "MM:SS"`
- `tailText(run, limit=1500): string`
- `currentRun(): Run|null` — `Run = { cmd, status: "running"|"done"|"failed"|"cancelled"|"timeout", startedAt, finishedAt, lastLine, tail: string[], chatId, messageId, cancelled?, timedOut? }`
- `startProcess(cmd, {argv, cwd, env?}, opts): Run|null` — null, если уже занято
- `startUnit(cmd, {unit}, opts): Run|null`
- `cancelRun(): boolean`
- `resetForTests(): void`
- `opts` (общие): `{ tg, chatId, messageId, loader, attached(): boolean, progressView(run): {text, rows}, onFinish(run): void|Promise, tickMs?, timeoutMs?, pollMs?, spawnImpl?, execFileImpl? }`

Прогресс-эдит: entity `custom_emoji` на первом символе (`loader.alt`); ответ `{ok:false, error_code:400}` (кроме «message is not modified») — одноразовый глобальный даунгрейд на `loader.fallback` до конца жизни процесса моста. `progressView` возвращает текст БЕЗ эмодзи — раннер сам префиксует.

- [ ] **Step 1: Написать падающий тест**

```js
// scripts/lib/menu/svc-run.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  LOADERS,
  stripAnsi,
  elapsed,
  tailText,
  currentRun,
  cancelRun,
  startProcess,
  startUnit,
  resetForTests,
} from "./svc-run.mjs";

// tg-мок: копит вызовы; fail400First — первый editMessageText с entities получает 400.
function makeTg({ fail400First = false } = {}) {
  const calls = [];
  let failed = false;
  const tg = async (method, body) => {
    calls.push({ method, body });
    if (fail400First && body.entities && !failed) {
      failed = true;
      return {
        ok: false,
        error_code: 400,
        description: "CUSTOM_EMOJI_INVALID",
      };
    }
    return { ok: true, result: {} };
  };
  return { tg, calls };
}

const baseOpts = (tg, over = {}) => ({
  tg,
  chatId: 10,
  messageId: 7,
  loader: LOADERS.doc,
  attached: () => true,
  progressView: (run) => ({
    text: `работаю ${run.lastLine}`,
    rows: [[{ text: "✖", callback_data: "iva_menu:svc:ab" }]],
  }),
  onFinish: () => {},
  tickMs: 15,
  timeoutMs: 5_000,
  pollMs: 5,
  ...over,
});

const waitFor = async (fn, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
};

test("stripAnsi: срезает цветовые и курсорные коды", () => {
  assert.equal(stripAnsi("\x1b[32m✓ ok\x1b[0m\r"), "✓ ok");
  assert.equal(stripAnsi("\x1b[?25lstep\x1b[?25h"), "step");
});

test("startProcess: успех — done, tail собран, прогресс шёл с custom_emoji entity", async () => {
  resetForTests();
  const { tg, calls } = makeTg();
  let finished = null;
  const run = startProcess(
    "doc",
    {
      argv: [
        process.execPath,
        "-e",
        "console.log('step one'); console.log('step two')",
      ],
    },
    baseOpts(tg, {
      onFinish: (r) => {
        finished = r;
      },
    }),
  );
  assert.ok(run);
  await waitFor(() => finished);
  assert.equal(finished.status, "done");
  assert.deepEqual(finished.tail, ["step one", "step two"]);
  assert.equal(currentRun(), run);
  // хотя бы один прогресс-эдит и он нёс entity нужного лоадера
  const rich = calls.find((c) => c.body.entities);
  assert.ok(rich);
  assert.equal(rich.body.entities[0].custom_emoji_id, LOADERS.doc.id);
  assert.ok(rich.body.text.startsWith(`${LOADERS.doc.alt} `));
});

test("startProcess: exit 1 — failed; второй старт при running — null", async () => {
  resetForTests();
  const { tg } = makeTg();
  let finished = null;
  const run = startProcess(
    "doc",
    {
      argv: [process.execPath, "-e", "setTimeout(()=>process.exit(1), 150)"],
    },
    baseOpts(tg, {
      onFinish: (r) => {
        finished = r;
      },
    }),
  );
  assert.ok(run);
  assert.equal(
    startProcess("cln", { argv: [process.execPath, "-e", "0"] }, baseOpts(tg)),
    null,
  );
  await waitFor(() => finished);
  assert.equal(finished.status, "failed");
});

test("cancelRun: SIGTERM ребёнку, статус cancelled", async () => {
  resetForTests();
  const { tg } = makeTg();
  let finished = null;
  startProcess(
    "cln",
    {
      argv: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"],
    },
    baseOpts(tg, {
      loader: LOADERS.cln,
      onFinish: (r) => {
        finished = r;
      },
    }),
  );
  await waitFor(() => currentRun()?.status === "running");
  assert.equal(cancelRun(), true);
  await waitFor(() => finished);
  assert.equal(finished.status, "cancelled");
  assert.equal(cancelRun(), false); // уже не running
});

test("startProcess: таймаут убивает и даёт status timeout", async () => {
  resetForTests();
  const { tg } = makeTg();
  let finished = null;
  startProcess(
    "doc",
    {
      argv: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"],
    },
    baseOpts(tg, {
      timeoutMs: 100,
      onFinish: (r) => {
        finished = r;
      },
    }),
  );
  await waitFor(() => finished);
  assert.equal(finished.status, "timeout");
});

test("прогресс: 400 на entity — даунгрейд на fallback до конца процесса", async () => {
  resetForTests();
  const { tg, calls } = makeTg({ fail400First: true });
  let finished = null;
  startProcess(
    "mem",
    {
      argv: [process.execPath, "-e", "setTimeout(()=>{}, 300)"],
    },
    baseOpts(tg, {
      loader: LOADERS.mem,
      tickMs: 30,
      onFinish: (r) => {
        finished = r;
      },
    }),
  );
  await waitFor(() => finished);
  const after400 = calls
    .slice(calls.findIndex((c) => c.body.entities) + 1)
    .filter(
      (c) =>
        c.method === "editMessageText" &&
        c.body.text?.startsWith(LOADERS.mem.fallback),
    );
  assert.ok(
    after400.length >= 1,
    "после 400 эдиты идут с fallback-символом без entities",
  );
  assert.ok(after400.every((c) => !c.body.entities));
});

test("attached()=false: тикер молчит, процесс всё равно доезжает", async () => {
  resetForTests();
  const { tg, calls } = makeTg();
  let finished = null;
  startProcess(
    "doc",
    {
      argv: [process.execPath, "-e", "console.log('quiet')"],
    },
    baseOpts(tg, {
      attached: () => false,
      onFinish: (r) => {
        finished = r;
      },
    }),
  );
  await waitFor(() => finished);
  assert.equal(finished.status, "done");
  assert.equal(calls.filter((c) => c.method === "editMessageText").length, 0);
});

test("startUnit: oneshot activating→inactive = done, журнал в tail", async () => {
  resetForTests();
  const { tg } = makeTg();
  const active = ["activating", "activating", "inactive"];
  const execFileImpl = (cmd, args, o, cb) => {
    const a = args.join(" ");
    if (a.includes("start")) return cb(null, "");
    if (a.includes("is-active")) return cb(null, active.shift() ?? "inactive");
    if (cmd === "journalctl") return cb(null, "sync ok\ncleanup ok\n");
    return cb(null, "");
  };
  let finished = null;
  startUnit(
    "mem",
    { unit: "iva-memory-doctor.service" },
    baseOpts(tg, {
      loader: LOADERS.mem,
      execFileImpl,
      onFinish: (r) => {
        finished = r;
      },
    }),
  );
  await waitFor(() => finished);
  assert.equal(finished.status, "done");
  assert.deepEqual(finished.tail, ["sync ok", "cleanup ok"]);
});

test("startUnit: failed юнит — status failed", async () => {
  resetForTests();
  const { tg } = makeTg();
  const execFileImpl = (cmd, args, o, cb) => {
    const a = args.join(" ");
    if (a.includes("start")) return cb(null, "");
    if (a.includes("is-active")) {
      const e = new Error("x");
      e.code = 3;
      return cb(e, "failed");
    }
    if (cmd === "journalctl") return cb(null, "boom\n");
    return cb(null, "");
  };
  let finished = null;
  startUnit(
    "mem",
    { unit: "iva-memory-doctor.service" },
    baseOpts(tg, {
      execFileImpl,
      onFinish: (r) => {
        finished = r;
      },
    }),
  );
  await waitFor(() => finished);
  assert.equal(finished.status, "failed");
  assert.deepEqual(finished.tail, ["boom"]);
});

test("elapsed/tailText: формат MM:SS и обрезка хвоста с конца", () => {
  const run = {
    startedAt: Date.now() - 65_000,
    finishedAt: Date.now(),
    tail: ["a".repeat(900), "b".repeat(900)],
  };
  assert.equal(elapsed(run), "01:05");
  const t = tailText(run, 1000);
  assert.ok(t.length <= 1000);
  assert.ok(t.includes("b"));
});
```

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `node --test scripts/lib/menu/svc-run.test.mjs`
Expected: FAIL — `Cannot find module './svc-run.mjs'`.

- [ ] **Step 3: Реализация `scripts/lib/menu/svc-run.mjs`**

```js
// Раннер экрана «Обслуживание» (svc): один долгий процесс на мост + живой прогресс
// анимированным custom emoji в сообщении меню. Спека: notes/specs/2026-07-25-menu-service-design.md.
//
// - spawn-команды (доктор, чистка) живут в cgroup моста — рестарт моста честно убивает их;
// - ночной цикл — штатный oneshot-юнит: старт --no-block, статус поллингом is-active
//   (activating → inactive|failed), переживает рестарт моста, отмена = systemctl stop;
// - custom emoji анимируется клиентом сам: редактируем не чаще tickMs и только при смене
//   payload; 400 от Telegram (владелец без Premium) — одноразовый даунгрейд на fallback
//   (паттерн editActive из scripts/lib/telegram-status.mjs).
import { spawn, execFile } from "node:child_process";

// Лоадеры из t.me/addemoji/LoadingStatusByTimDesign — набор /update (🟩) и working-status
// (🔵); id — первые в своей цветовой группе, как у двух уже используемых. Не переводы.
export const LOADERS = {
  doc: { alt: "🟥", id: "5255894270597941229", fallback: "◇" },
  cln: { alt: "🟨", id: "5255975857796695002", fallback: "◇" },
  mem: { alt: "🟪", id: "5256218768262056531", fallback: "◇" },
};

export const TIMEOUT_MS = { doc: 600_000, cln: 1_800_000, mem: 3_600_000 };
const TICK_MS = 3_000;
const POLL_MS = 3_000;
const TAIL_LINES = 40;

let RUN = null; // единственный запуск на мост
let customEmojiOk = true; // глобальный даунгрейд после первого 400

export const currentRun = () => RUN;
export function resetForTests() {
  RUN = null;
  customEmojiOk = true;
}

export function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "");
}

export function elapsed(run) {
  const s = Math.max(
    0,
    Math.floor(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000),
  );
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Хвост вывода с конца, суммарно не длиннее limit (запас от лимита 4096 editMessageText).
export function tailText(run, limit = 1500) {
  const out = [];
  let len = 0;
  for (let i = run.tail.length - 1; i >= 0; i--) {
    const line = run.tail[i];
    if (len + line.length + 1 > limit) break;
    out.unshift(line);
    len += line.length + 1;
  }
  return out.join("\n");
}

function baseRun(cmd, opts) {
  return {
    cmd,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    lastLine: "",
    tail: [],
    cancelled: false,
    timedOut: false,
    chatId: opts.chatId,
    messageId: opts.messageId,
    _edit: { lastPayload: "" },
    _timer: null,
    _kill: null,
  };
}

function pushLines(run, chunk) {
  for (const line of stripAnsi(chunk.toString())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    run.lastLine = line;
    run.tail.push(line);
    if (run.tail.length > TAIL_LINES) run.tail.shift();
  }
}

// Эдит с custom_emoji entity; «not modified» = успех; 400 — даунгрейд и повтор с fallback.
async function editRich(opts, run, text, rows) {
  const reply_markup = rows ? { inline_keyboard: rows } : undefined;
  const payload = JSON.stringify([text, rows, customEmojiOk]);
  if (run._edit.lastPayload === payload) return;
  run._edit.lastPayload = payload;
  const base = { chat_id: run.chatId, message_id: run.messageId, reply_markup };
  if (customEmojiOk) {
    const L = opts.loader;
    const r = await opts
      .tg("editMessageText", {
        ...base,
        text: `${L.alt} ${text}`,
        entities: [
          {
            type: "custom_emoji",
            offset: 0,
            length: L.alt.length,
            custom_emoji_id: L.id,
          },
        ],
      })
      .catch(() => ({ ok: false }));
    if (r.ok || /not modified/i.test(r.description || "")) return;
    if (r.error_code !== 400) return;
    customEmojiOk = false;
  }
  await opts
    .tg("editMessageText", { ...base, text: `${opts.loader.fallback} ${text}` })
    .catch(() => {});
}

function startTicker(run, opts) {
  const tick = async () => {
    if (run.status !== "running") {
      clearInterval(run._timer);
      return;
    }
    if (opts.attached && !opts.attached()) return; // юзер ушёл с экрана — не дерёмся за сообщение
    const v = opts.progressView(run);
    await editRich(opts, run, v.text, v.rows);
  };
  run._timer = setInterval(tick, opts.tickMs ?? TICK_MS);
  if (run._timer.unref) run._timer.unref();
  tick();
}

function finish(run, status, opts) {
  if (run.status !== "running") return;
  run.status = status;
  run.finishedAt = Date.now();
  clearInterval(run._timer);
  Promise.resolve(opts.onFinish?.(run)).catch(() => {});
}

export function startProcess(cmd, spec, opts) {
  if (RUN && RUN.status === "running") return null;
  const run = (RUN = baseRun(cmd, opts));
  let child;
  try {
    child = (opts.spawnImpl ?? spawn)(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    pushLines(run, String(e.message || e));
    finish(run, "failed", opts);
    return run;
  }
  run._kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {}
  };
  child.stdout.on("data", (b) => pushLines(run, b));
  child.stderr.on("data", (b) => pushLines(run, b));
  const timer = setTimeout(() => {
    run.timedOut = true;
    run._kill();
  }, opts.timeoutMs ?? TIMEOUT_MS[cmd]);
  if (timer.unref) timer.unref();
  child.on("error", (e) => {
    clearTimeout(timer);
    pushLines(run, String(e.message || e));
    finish(run, "failed", opts);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    const status = run.cancelled
      ? "cancelled"
      : run.timedOut
        ? "timeout"
        : code === 0
          ? "done"
          : "failed";
    finish(run, status, opts);
  });
  startTicker(run, opts);
  return run;
}

export function startUnit(cmd, { unit }, opts) {
  if (RUN && RUN.status === "running") return null;
  const run = (RUN = baseRun(cmd, opts));
  const ex = opts.execFileImpl ?? execFile;
  const sysctl = (args) =>
    new Promise((resolve) =>
      ex(
        "systemctl",
        ["--user", ...args],
        { timeout: 15_000, encoding: "utf8" },
        (err, out = "") =>
          resolve({
            code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
            out: String(out).trim(),
          }),
      ),
    );
  const journal = () =>
    new Promise((resolve) =>
      ex(
        "journalctl",
        ["--user", "-u", unit, "-n", "15", "--no-pager", "-o", "cat"],
        { timeout: 15_000, encoding: "utf8" },
        (err, out = "") =>
          resolve(
            stripAnsi(String(out))
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
          ),
      ),
    );
  run._kill = () => {
    sysctl(["stop", unit]);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    const started = await sysctl(["start", "--no-block", unit]);
    if (started.code !== 0) {
      pushLines(run, started.out || "systemctl start failed");
      return finish(run, "failed", opts);
    }
    const deadline = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS[cmd]);
    for (;;) {
      await wait(opts.pollMs ?? POLL_MS);
      if (run.status !== "running") return;
      const st = await sysctl(["is-active", unit]);
      if (
        ["activating", "active", "reloading", "deactivating"].includes(st.out)
      ) {
        if (Date.now() > deadline) return finish(run, "timeout", opts); // юнит НЕ убиваем
        continue;
      }
      run.tail = await journal(); // inactive|failed — конец, итог из журнала
      if (run.cancelled) return finish(run, "cancelled", opts);
      return finish(run, st.out === "failed" ? "failed" : "done", opts);
    }
  })();
  startTicker(run, opts);
  return run;
}

export function cancelRun() {
  if (!RUN || RUN.status !== "running") return false;
  RUN.cancelled = true;
  RUN._kill?.();
  return true;
}
```

- [ ] **Step 4: Прогнать тесты раннера**

Run: `node --test scripts/lib/menu/svc-run.test.mjs`
Expected: PASS (10 tests). Если `attached()=false`-тест мигает из-за первого tick — первый tick тоже проверяет attached, флака быть не должно.

- [ ] **Step 5: Полный прогон меню-тестов и коммит**

Run: `node --test scripts/lib/menu/`
Expected: все PASS (старые экраны не тронуты).

```bash
git add scripts/lib/menu/svc-run.mjs scripts/lib/menu/svc-run.test.mjs
git commit -m "feat(menu): maintenance runner — process/unit mechanics with live custom-emoji progress"
```

---

### Task 2: Экран `service.mjs` + кнопка в root + регистрация + проводка deps

**Files:**

- Create: `scripts/lib/menu/service.mjs`
- Modify: `scripts/lib/menu/root.mjs:16-19` (пара Статус+Обслуживание, Закрыть в свой ряд)
- Modify: `scripts/lib/menu/index.mjs` (import + `SCREENS.svc` + sid в комменте грамматики)
- Modify: `scripts/telegram-poll.mjs:663` (deps: `handleUpdateCheck`)
- Test: `scripts/lib/menu/service.test.mjs`

**Interfaces:**

- Consumes (Task 1): `LOADERS, TIMEOUT_MS, currentRun, cancelRun, startProcess, startUnit, elapsed, tailText, resetForTests` из `./svc-run.mjs`.
- Produces: экран `svc` `{parent:"r", render, on}`; вербы `c:<cmd>` (подтверждение), `go:<cmd>` (запуск), `ab` (отмена), `up` (хендофф). `<cmd>` ∈ `doc|cln|mem`.
- Тестовые инъекции через deps: `deps.svcSpec(cmd, ctx)` — подмена командной строки; `deps.svcRun = {tickMs, timeoutMs, pollMs, execFileImpl}`.

- [ ] **Step 1: Написать падающие тесты**

```js
// scripts/lib/menu/service.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import service from "./service.mjs";
import root from "./root.mjs";
import { SCREENS } from "./index.mjs";
import { LOADERS, currentRun, resetForTests } from "./svc-run.mjs";
import { acquireUpdateLock, releaseUpdateLock } from "../update-safety.mjs";

// стенд как в menu-screens.test.mjs + захват прямых tg-вызовов раннера
function makeCtx({ lang = "ru", deps = {} } = {}) {
  const rendered = [];
  const tgCalls = [];
  const flows = {
    screen: async (st, text, rows) => {
      st.msgId ??= 1;
      st._last = { text, rows };
      rendered.push({ text, rows });
    },
    end: async (st, text, rows) => {
      st._last = { text, rows };
      rendered.push({ text, rows });
    },
    get: () => harness.st,
    touch: () => {},
  };
  const ctx = {
    tg: async (method, body) => {
      tgCalls.push({ method, body });
      return { ok: true, result: {} };
    },
    deps,
    flows,
    lang,
    tr: (en, ru) => (lang === "ru" ? ru : en),
    getLang: () => lang,
    btn: (text, data) => ({ text, callback_data: data }),
    backRow: () => [{ text: "‹ Назад", callback_data: "iva_menu:r:o" }],
    show: async (st, sid) => {
      st.screen = sid;
      const v = await service.render(st, ctx);
      if (v) await flows.screen(st, v.text, v.rows);
    },
  };
  const harness = { ctx, flows, rendered, tgCalls, st: null };
  return harness;
}

const newState = (over = {}) => ({
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

const waitFor = async (fn, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
};

const fastRun = { tickMs: 15, timeoutMs: 5000, pollMs: 5 };

test("svc зарегистрирован в движке, root ведёт на него, Закрыть в своём ряду", () => {
  assert.equal(SCREENS.svc, service);
  const view = root.render(newState({ screen: "r" }), makeCtx().ctx);
  const flat = view.rows.flat();
  assert.ok(flat.some((b) => b.callback_data === "iva_menu:svc:o"));
  const closeRow = view.rows.find((r) =>
    r.some((b) => b.callback_data === "iva_menu:r:x"),
  );
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
    const data = st._last.rows.flat().map((b) => b.callback_data);
    assert.ok(data.includes(`iva_menu:svc:go:${cmd}`));
    assert.ok(data.includes("iva_menu:svc:o")); // Назад к списку
  }
});

test("up: хендофф в deps.handleUpdateCheck с chatId", async () => {
  resetForTests();
  let called = null;
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
  assert.equal(rich.body.entities[0].custom_emoji_id, LOADERS.doc.id);
  const final = h.tgCalls.filter((c) => /✅/.test(c.body.text || "")).at(-1);
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
      svcSpec: () => ({
        kind: "proc",
        argv: [
          process.execPath,
          "-e",
          "console.log('cleanup (apply): 3 file(s), 224,000,000 bytes of bug garbage removed')",
        ],
      }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["cln"], st, h.ctx);
  await waitFor(() =>
    h.tgCalls.some(
      (c) => /Чистка/.test(c.body.text || "") && /✅/.test(c.body.text),
    ),
  );
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
  assert.match(st._last.text, /обновлени/i);
  releaseUpdateLock(lock);
});
```

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `node --test scripts/lib/menu/service.test.mjs`
Expected: FAIL — `Cannot find module './service.mjs'`.

- [ ] **Step 3: Реализация `scripts/lib/menu/service.mjs`**

```js
// Экран «🛠 Обслуживание»: доктор / чистка vault / ночной цикл памяти / обновление.
// Вся механика запуска и прогресса — svc-run.mjs; здесь вьюхи, копирайт и гейты.
// Спека: notes/specs/2026-07-25-menu-service-design.md.
//
// Вербы: c:<cmd> подтверждение (stateless-вьюха), go:<cmd> запуск, ab отмена,
// up — хендофф в существующий /update-флоу (deps.handleUpdateCheck).
// render сам решает, что показать: идёт процесс → прогресс; иначе список.
import { join } from "node:path";
import { readEnvValues } from "../env-file.mjs";
import { acquireUpdateLock, releaseUpdateLock } from "../update-safety.mjs";
import {
  LOADERS,
  currentRun,
  cancelRun,
  startProcess,
  startUnit,
  elapsed,
  tailText,
} from "./svc-run.mjs";

const CMDS = new Set(["doc", "cln", "mem"]);
const MEM_UNIT = "iva-memory-doctor.service";

const label = (cmd, T) =>
  ({
    doc: T("🩺 Doctor", "🩺 Доктор"),
    cln: T("🧹 Vault cleanup", "🧹 Чистка vault"),
    mem: T("🌙 Night memory cycle", "🌙 Ночной цикл"),
  })[cmd];

const describe = (cmd, T) =>
  ({
    doc: T(
      "Diagnoses and auto-repairs the install: units, timers, port, .env, build.\nUsually 10–60 seconds (up to minutes if a rebuild is needed).",
      "Диагностика и авто-починка инсталляции: юниты, таймеры, порт, .env, сборка.\nОбычно 10–60 секунд (до минут, если нужна пересборка).",
    ),
    cln: T(
      "Streams every memory card and removes the description bloat from the 0.3.0 bug. Safe for card bodies.\nUsually under a minute; gigabyte files take longer.",
      "Проходит по карточкам памяти стримингом и убирает раздутые description из бага 0.3.0. Тела карточек не трогает.\nОбычно меньше минуты; гигабайтные файлы — дольше.",
    ),
    mem: T(
      "Runs the nightly memory doctor now, without waiting for 05:00: script sync → cleanup → enforce → graph → git push.\nUsually 1–10 minutes.",
      "Запускает ночной цикл памяти сейчас, не дожидаясь 05:00: синк скриптов → cleanup → enforce → graph → git push.\nОбычно 1–10 минут.",
    ),
  })[cmd];

// Командные строки. deps.svcSpec — тестовая подмена (argv на быстрые node -e).
async function commandSpec(cmd, ctx) {
  if (ctx.deps.svcSpec) return ctx.deps.svcSpec(cmd, ctx);
  const root = ctx.deps.root;
  if (cmd === "doc")
    return {
      kind: "proc",
      argv: [process.execPath, join(root, "bin/iva.mjs"), "doctor"],
      cwd: root,
    };
  if (cmd === "cln") {
    const env = await readEnvValues(ctx.deps.envPath);
    const rel = env.ASSISTANT_VAULT_DIR || "vault";
    const vaultDir = rel.startsWith("/") ? rel : join(root, rel);
    return {
      kind: "proc",
      argv: [
        "uv",
        "run",
        ".claude/skills/autograph/scripts/cleanup.py",
        ".",
        "--apply",
      ],
      cwd: vaultDir,
    };
  }
  return { kind: "unit", unit: MEM_UNIT };
}

function progressView(run, ctx) {
  const T = ctx.tr;
  const step = run.lastLine || T("Working…", "Работаю…");
  return {
    text: `${label(run.cmd, T)} — ${elapsed(run)}\n${step}`,
    rows: [[ctx.btn(T("✖ Cancel", "✖ Отменить"), "iva_menu:svc:ab")]],
  };
}

// Финальная сводка. Чистка: парсим «cleanup (apply): N file(s), X bytes …» → файлы и МБ.
function summaryText(run, ctx) {
  const T = ctx.tr;
  const name = label(run.cmd, T);
  const took = elapsed(run);
  if (run.status === "cancelled")
    return T(`✖ Cancelled: ${name} · ${took}`, `✖ Прервано: ${name} · ${took}`);
  if (run.status === "timeout") {
    if (run.cmd === "mem")
      return T(
        `⏳ Still running after ${took} — check: journalctl --user -u ${MEM_UNIT}`,
        `⏳ Всё ещё идёт (${took}) — смотри: journalctl --user -u ${MEM_UNIT}`,
      );
    return T(
      `⚠️ Timed out: ${name} · ${took}`,
      `⚠️ Не уложился в лимит: ${name} · ${took}`,
    );
  }
  const ok = run.status === "done";
  if (run.cmd === "cln" && ok) {
    const m = run.tail
      .join("\n")
      .match(/cleanup \((?:apply|dry-run)\): (\d+) file\(s\), ([\d,]+) bytes/);
    if (m) {
      const files = Number(m[1]);
      const mb = (Number(m[2].replace(/,/g, "")) / 1e6).toFixed(files ? 1 : 0);
      return files
        ? T(
            `✅ Cleanup: ${files} file(s), ${mb} MB of garbage removed · ${took}`,
            `✅ Чистка: ${files} файл(ов), ${mb} МБ мусора убрано · ${took}`,
          )
        : T(
            `✅ Cleanup: vault is clean · ${took}`,
            `✅ Чистка: vault чистый · ${took}`,
          );
    }
  }
  if (run.cmd === "mem" && ok)
    return T(
      `✅ Memory cycle finished in ${took}`,
      `✅ Цикл памяти пройден за ${took}`,
    );
  const head =
    run.cmd === "doc"
      ? ok
        ? T("✅ Diagnostics passed", "✅ Диагностика пройдена")
        : T("⚠️ Issues found", "⚠️ Есть проблемы")
      : ok
        ? T(`✅ Done: ${name}`, `✅ Готово: ${name}`)
        : T(`⚠️ Failed: ${name}`, `⚠️ Упало: ${name}`);
  const tail = tailText(run);
  return tail ? `${head} · ${took}\n\n${tail}` : `${head} · ${took}`;
}

function lastRunLine(run, ctx) {
  const T = ctx.tr;
  const icon =
    { done: "✅", failed: "⚠️", cancelled: "✖", timeout: "⏳" }[run.status] ||
    "•";
  return T(
    `${icon} Last run: ${label(run.cmd, T)} · ${elapsed(run)}`,
    `${icon} Последний запуск: ${label(run.cmd, T)} · ${elapsed(run)}`,
  );
}

function idleView(st, ctx) {
  const T = ctx.tr;
  const lines = [
    T("🛠 Maintenance", "🛠 Обслуживание"),
    "",
    T(
      "Diagnostics and upkeep for this install.",
      "Диагностика и уход за инсталляцией.",
    ),
  ];
  const run = currentRun();
  if (run && run.status !== "running") lines.push("", lastRunLine(run, ctx));
  return {
    text: lines.join("\n"),
    rows: [
      [
        ctx.btn(label("doc", T), "iva_menu:svc:c:doc"),
        ctx.btn(label("cln", T), "iva_menu:svc:c:cln"),
      ],
      [
        ctx.btn(label("mem", T), "iva_menu:svc:c:mem"),
        ctx.btn(T("🔄 Update", "🔄 Обновление"), "iva_menu:svc:up"),
      ],
      ctx.backRow("r"),
    ],
  };
}

async function startCommand(cmd, st, ctx) {
  const T = ctx.tr;
  // Гейт 1: уже занято — показать прогресс текущего.
  const running = currentRun();
  if (running && running.status === "running") {
    const v = progressView(running, ctx);
    return ctx.flows.screen(
      st,
      T(`Already running:\n${v.text}`, `Уже идёт:\n${v.text}`),
      v.rows,
    );
  }
  // Гейт 2: идёт обновление — в репо чужим процессам нельзя (probe: взяли лок — отпустили).
  if (cmd !== "mem") {
    const lock = acquireUpdateLock(ctx.deps.dataDir, "menu-svc");
    if (!lock.ok) {
      return ctx.flows.screen(
        st,
        T(
          "⬆️ An update is in progress — try again after it finishes.",
          "⬆️ Идёт обновление — попробуй после его завершения.",
        ),
        [ctx.backRow("r")],
      );
    }
    releaseUpdateLock(lock);
  }
  const spec = await commandSpec(cmd, ctx);
  const over = ctx.deps.svcRun || {};
  const opts = {
    tg: ctx.tg,
    chatId: st.chatId,
    messageId: st.msgId,
    loader: LOADERS[cmd],
    attached: () =>
      ctx.flows.get(st.chatId, st.userId) === st && st.screen === "svc",
    progressView: (run) => progressView(run, ctx),
    onFinish: async (run) => {
      // Итог рисуем, только если юзер всё ещё на экране svc — иначе сводка ждёт в render.
      if (!(ctx.flows.get(st.chatId, st.userId) === st && st.screen === "svc"))
        return;
      await ctx
        .tg("editMessageText", {
          chat_id: run.chatId,
          message_id: run.messageId,
          text: summaryText(run, ctx),
          reply_markup: {
            inline_keyboard: [
              [ctx.btn(ctx.tr("‹ Back", "‹ Назад"), "iva_menu:svc:o")],
            ],
          },
        })
        .catch(() => {});
    },
    ...over,
  };
  const run =
    spec.kind === "unit"
      ? startUnit(cmd, spec, opts)
      : startProcess(cmd, spec, opts);
  if (!run) {
    // гонка: кто-то успел стартовать между гейтом и стартом
    const v = progressView(currentRun(), ctx);
    return ctx.flows.screen(
      st,
      T(`Already running:\n${v.text}`, `Уже идёт:\n${v.text}`),
      v.rows,
    );
  }
}

export default {
  parent: "r",
  async render(st, ctx) {
    const run = currentRun();
    if (run && run.status === "running") return progressView(run, ctx);
    return idleView(st, ctx);
  },
  async on(verb, args, st, ctx) {
    const T = ctx.tr;
    if (verb === "c" && CMDS.has(args[0])) {
      const cmd = args[0];
      return ctx.flows.screen(st, `${label(cmd, T)}\n\n${describe(cmd, T)}`, [
        [ctx.btn(T("▶ Run", "▶ Запустить"), `iva_menu:svc:go:${cmd}`)],
        [ctx.btn(T("‹ Back", "‹ Назад"), "iva_menu:svc:o")],
      ]);
    }
    if (verb === "go" && CMDS.has(args[0]))
      return startCommand(args[0], st, ctx);
    if (verb === "ab") {
      if (cancelRun())
        return ctx.flows.screen(st, T("Stopping…", "Останавливаю…"), []);
      return ctx.show(st, "svc"); // нечего отменять — перерисовать текущее состояние
    }
    if (verb === "up") return ctx.deps.handleUpdateCheck?.(st.chatId);
  },
};
```

- [ ] **Step 4: Кнопка в root — `scripts/lib/menu/root.mjs`**

Заменить две последние строки rows:

```js
      [b(T("⏰ Timers", "⏰ Кроны"), "iva_menu:cron:o"), b(T("🧩 Skills", "🧩 Скиллы"), "iva_menu:sk:o")],
      [b(T("📊 Status", "📊 Статус"), "iva_menu:st:o"), b(T("🛠 Maintenance", "🛠 Обслуживание"), "iva_menu:svc:o")],
      [b(T("✖ Close", "✖ Закрыть"), "iva_menu:r:x")],
```

- [ ] **Step 5: Регистрация — `scripts/lib/menu/index.mjs`**

```js
import service from "./service.mjs";
```

В `SCREENS` добавить `svc: service,` после `st: status,`. В комменте грамматики (строка 11) дополнить список sid: `... sk st svc`.

- [ ] **Step 6: Проводка deps — `scripts/telegram-poll.mjs:663`**

В объект `deps` `createMenu` добавить строку:

```js
    handleUpdateCheck,
```

(функция объявлена выше в том же файле, `export async function handleUpdateCheck`.)

- [ ] **Step 7: Прогнать все тесты**

Run: `node --test scripts/lib/menu/`
Expected: PASS (svc-run + service + старые menu-screens/menu-index). Если menu-index.test.mjs держит снапшот root-кнопок — обновить ожидание на новый ряд (пара Статус/Обслуживание, Закрыть отдельно).

- [ ] **Step 8: Смоук синтаксиса моста**

Run: `node --check scripts/telegram-poll.mjs && node --check scripts/lib/menu/index.mjs`
Expected: тихо, код 0.

- [ ] **Step 9: Коммит**

```bash
git add scripts/lib/menu/service.mjs scripts/lib/menu/service.test.mjs scripts/lib/menu/root.mjs scripts/lib/menu/index.mjs scripts/telegram-poll.mjs
git commit -m "feat(menu): maintenance screen — doctor, vault cleanup, night memory cycle, update handoff"
```

---

### Task 3: Документация `docs/menu.md`

**Files:**

- Modify: `docs/menu.md` (карта + новый раздел после «Status»/таблицы применения)

**Interfaces:** Consumes: имена кнопок/команд из Task 2. Produces: ничего для кода.

- [ ] **Step 1: Обновить карту меню**

В блоке «The map» заменить последнюю строку-пару:

```
[📊 Status]    [🛠 Maintenance]
[✖ Close]
```

- [ ] **Step 2: Добавить раздел (после раздела про Status, тон и стиль файла сохранить)**

```markdown
## Maintenance

**🛠 Maintenance** gathers the install's technical commands so none of them need SSH:

- **🩺 Doctor** — `iva doctor`: diagnoses and auto-repairs units, timers, port, `.env`, build.
- **🧹 Vault cleanup** — the streaming cleaner from 0.3.1 (`cleanup.py --apply`): collapses description bloat, never touches card bodies.
- **🌙 Night memory cycle** — starts the nightly `iva-memory-doctor.service` right now instead of 05:00; it runs as the same systemd unit, so it survives bridge restarts.
- **🔄 Update** — hands off to the existing `/update` flow (check → confirm buttons → an update that survives its own restart).

Every command asks for confirmation, then shows live progress in the same message — an animated loader from the same custom-emoji pack the update flow uses (red for doctor, yellow for cleanup, purple for the memory cycle; plain ◇ when the bot owner has no Premium), the current step and elapsed time, with a ✖ Cancel button. One command runs at a time, and doctor/cleanup refuse to start while an update is in progress. The final summary is a single line with numbers (files cleaned and MB freed, ok/warn counts) plus the output tail when something failed.
```

- [ ] **Step 3: Коммит**

```bash
git add docs/menu.md
git commit -m "docs(menu): maintenance section — doctor, cleanup, night cycle, update from chat"
```

---

### Task 4: Релиз 0.3.2 — версия, CHANGELOG, пуш, деплой на этом VPS

**Files:**

- Modify: `package.json` (`"version": "0.3.2"`)
- Modify: `CHANGELOG.md` (новая секция сверху)

- [ ] **Step 1: Bump версии**

В `package.json`: `"version": "0.3.1"` → `"version": "0.3.2"`.

- [ ] **Step 2: CHANGELOG**

Вставить после строки `# Changelog`:

```markdown
## [0.3.2] - 2026-07-25

Feature: a 🛠 Maintenance screen in `/menu` — the install's technical commands right in chat.

- 🛠 **Maintenance in `/menu`** — 🩺 Doctor (`iva doctor`), 🧹 Vault cleanup (the 0.3.1 streaming cleaner), 🌙 Night memory cycle (runs the nightly doctor unit right now instead of 05:00) and 🔄 Update (hands off to the existing `/update` flow). Confirmation before every run, live progress in the same message — an animated loader from the update flow's emoji pack, one color per command, the current step and elapsed time, a ✖ Cancel button — and a one-line summary with numbers at the end.
- 🚦 **Safe by construction** — one command at a time, doctor/cleanup refuse to start while an update is running, timeouts on everything, and the night cycle runs as its own systemd unit so a bridge restart can't orphan it.

[0.3.2]: https://github.com/smixs/iva/releases/tag/v0.3.2
```

- [ ] **Step 3: Полный прогон тестов перед релизом**

Run: `node --test scripts/lib/menu/ && npm run test:update-ui`
Expected: все PASS.

- [ ] **Step 4: Коммит релиза, тег, пуш**

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): 0.3.2"
git tag v0.3.2
git push origin main --follow-tags
```

- [ ] **Step 5: GitHub release**

```bash
gh release create v0.3.2 --title "v0.3.2 — Maintenance in /menu" --notes "$(sed -n '/## \[0.3.2\]/,/^\[0.3.2\]/p' CHANGELOG.md | head -n -1 | tail -n +2)"
```

Expected: ссылка на релиз в stdout.

- [ ] **Step 6: Деплой на этом VPS**

Меню живёт в мосте — деплой = рестарт только моста:

```bash
systemctl --user restart iva-telegram-poll.service
sleep 3 && systemctl --user is-active iva-telegram-poll.service
journalctl --user -u iva-telegram-poll.service -n 5 --no-pager
```

Expected: `active`, в логе штатный старт без стектрейсов.

---

## Self-review (выполнен)

- Покрытие спеки: экран+кнопка (T2), эмодзи и даунгрейд (T1), гибрид запуска (T1/T2), гейты busy/update-lock (T2), сводки всех команд (T2), отмена и таймауты (T1/T2), хендофф update (T2), docs (T3), релиз (T4). «Последний запуск» на idle — T2 `lastRunLine`.
- Плейсхолдеров нет; все код-блоки полные.
- Сигнатуры Task 1 ↔ Task 2 сверены (`startProcess/startUnit/currentRun/cancelRun/elapsed/tailText/LOADERS`, opts-поля).
