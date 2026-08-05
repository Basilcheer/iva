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
