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

let RUN = null;            // единственный запуск на мост
let customEmojiOk = true;  // глобальный даунгрейд после первого 400

export const currentRun = () => RUN;
export function resetForTests() { RUN = null; customEmojiOk = true; }

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

export function elapsed(run) {
  const s = Math.max(0, Math.floor(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
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
    cmd, status: "running", startedAt: Date.now(), finishedAt: null,
    lastLine: "", tail: [], cancelled: false, timedOut: false,
    chatId: opts.chatId, messageId: opts.messageId,
    _edit: { lastPayload: "" }, _timer: null, _kill: null,
  };
}

function pushLines(run, chunk) {
  for (const line of stripAnsi(chunk.toString()).split("\n").map((l) => l.trim()).filter(Boolean)) {
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
    const r = await opts.tg("editMessageText", {
      ...base,
      text: `${L.alt} ${text}`,
      entities: [{ type: "custom_emoji", offset: 0, length: L.alt.length, custom_emoji_id: L.id }],
    }).catch(() => ({ ok: false }));
    if (r.ok || /not modified/i.test(r.description || "")) return;
    if (r.error_code !== 400) return;
    customEmojiOk = false;
  }
  await opts.tg("editMessageText", { ...base, text: `${opts.loader.fallback} ${text}` }).catch(() => {});
}

function startTicker(run, opts) {
  const tick = async () => {
    if (run.status !== "running") { clearInterval(run._timer); return; }
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
      cwd: spec.cwd, env: spec.env ?? process.env, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    pushLines(run, String(e.message || e));
    finish(run, "failed", opts);
    return run;
  }
  run._kill = () => { try { child.kill("SIGTERM"); } catch {} };
  child.stdout.on("data", (b) => pushLines(run, b));
  child.stderr.on("data", (b) => pushLines(run, b));
  const timer = setTimeout(() => { run.timedOut = true; run._kill(); }, opts.timeoutMs ?? TIMEOUT_MS[cmd]);
  if (timer.unref) timer.unref();
  child.on("error", (e) => { clearTimeout(timer); pushLines(run, String(e.message || e)); finish(run, "failed", opts); });
  child.on("close", (code) => {
    clearTimeout(timer);
    const status = run.cancelled ? "cancelled" : run.timedOut ? "timeout" : code === 0 ? "done" : "failed";
    finish(run, status, opts);
  });
  startTicker(run, opts);
  return run;
}

export function startUnit(cmd, { unit }, opts) {
  if (RUN && RUN.status === "running") return null;
  const run = (RUN = baseRun(cmd, opts));
  const ex = opts.execFileImpl ?? execFile;
  const sysctl = (args) => new Promise((resolve) =>
    ex("systemctl", ["--user", ...args], { timeout: 15_000, encoding: "utf8" }, (err, out = "") =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: String(out).trim() })),
  );
  const journal = () => new Promise((resolve) =>
    ex("journalctl", ["--user", "-u", unit, "-n", "15", "--no-pager", "-o", "cat"], { timeout: 15_000, encoding: "utf8" },
      (err, out = "") => resolve(stripAnsi(String(out)).split("\n").map((l) => l.trim()).filter(Boolean))),
  );
  run._kill = () => { sysctl(["stop", unit]); };
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
      if (["activating", "active", "reloading", "deactivating"].includes(st.out)) {
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
