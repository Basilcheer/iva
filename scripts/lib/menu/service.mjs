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
  LOADERS, currentRun, cancelRun, startProcess, startUnit, elapsed, tailText,
} from "./svc-run.mjs";

const CMDS = new Set(["doc", "cln", "mem"]);
const MEM_UNIT = "iva-memory-doctor.service";

const label = (cmd, T) => ({
  doc: T("🩺 Doctor", "🩺 Доктор"),
  cln: T("🧹 Vault cleanup", "🧹 Чистка vault"),
  mem: T("🌙 Night memory cycle", "🌙 Ночной цикл"),
}[cmd]);

const describe = (cmd, T) => ({
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
}[cmd]);

// Командные строки. deps.svcSpec — тестовая подмена (argv на быстрые node -e).
async function commandSpec(cmd, ctx) {
  if (ctx.deps.svcSpec) return ctx.deps.svcSpec(cmd, ctx);
  const root = ctx.deps.root;
  if (cmd === "doc") return { kind: "proc", argv: [process.execPath, join(root, "bin/iva.mjs"), "doctor"], cwd: root };
  if (cmd === "cln") {
    const env = await readEnvValues(ctx.deps.envPath);
    const rel = env.ASSISTANT_VAULT_DIR || "vault";
    const vaultDir = rel.startsWith("/") ? rel : join(root, rel);
    return { kind: "proc", argv: ["uv", "run", ".claude/skills/autograph/scripts/cleanup.py", ".", "--apply"], cwd: vaultDir };
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
  if (run.status === "cancelled") return T(`✖ Cancelled: ${name} · ${took}`, `✖ Прервано: ${name} · ${took}`);
  if (run.status === "timeout") {
    if (run.cmd === "mem") return T(
      `⏳ Still running after ${took} — check: journalctl --user -u ${MEM_UNIT}`,
      `⏳ Всё ещё идёт (${took}) — смотри: journalctl --user -u ${MEM_UNIT}`,
    );
    return T(`⚠️ Timed out: ${name} · ${took}`, `⚠️ Не уложился в лимит: ${name} · ${took}`);
  }
  const ok = run.status === "done";
  if (run.cmd === "cln" && ok) {
    const m = run.tail.join("\n").match(/cleanup \((?:apply|dry-run)\): (\d+) file\(s\), ([\d,]+) bytes/);
    if (m) {
      const files = Number(m[1]);
      const mb = (Number(m[2].replace(/,/g, "")) / 1e6).toFixed(files ? 1 : 0);
      return files
        ? T(`✅ Cleanup: ${files} file(s), ${mb} MB of garbage removed · ${took}`,
            `✅ Чистка: ${files} файл(ов), ${mb} МБ мусора убрано · ${took}`)
        : T(`✅ Cleanup: vault is clean · ${took}`, `✅ Чистка: vault чистый · ${took}`);
    }
  }
  if (run.cmd === "mem" && ok) return T(`✅ Memory cycle finished in ${took}`, `✅ Цикл памяти пройден за ${took}`);
  const head =
    run.cmd === "doc"
      ? ok ? T("✅ Diagnostics passed", "✅ Диагностика пройдена") : T("⚠️ Issues found", "⚠️ Есть проблемы")
      : ok ? T(`✅ Done: ${name}`, `✅ Готово: ${name}`) : T(`⚠️ Failed: ${name}`, `⚠️ Упало: ${name}`);
  const tail = tailText(run);
  return tail ? `${head} · ${took}\n\n${tail}` : `${head} · ${took}`;
}

function lastRunLine(run, ctx) {
  const T = ctx.tr;
  const icon = { done: "✅", failed: "⚠️", cancelled: "✖", timeout: "⏳" }[run.status] || "•";
  return T(`${icon} Last run: ${label(run.cmd, T)} · ${elapsed(run)}`,
           `${icon} Последний запуск: ${label(run.cmd, T)} · ${elapsed(run)}`);
}

function idleView(st, ctx) {
  const T = ctx.tr;
  const lines = [T("🛠 Maintenance", "🛠 Обслуживание"), "", T("Diagnostics and upkeep for this install.", "Диагностика и уход за инсталляцией.")];
  const run = currentRun();
  if (run && run.status !== "running") lines.push("", lastRunLine(run, ctx));
  return {
    text: lines.join("\n"),
    rows: [
      [ctx.btn(label("doc", T), "iva_menu:svc:c:doc"), ctx.btn(label("cln", T), "iva_menu:svc:c:cln")],
      [ctx.btn(label("mem", T), "iva_menu:svc:c:mem"), ctx.btn(T("🔄 Update", "🔄 Обновление"), "iva_menu:svc:up")],
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
    return ctx.flows.screen(st, T(`Already running:\n${v.text}`, `Уже идёт:\n${v.text}`), v.rows);
  }
  // Гейт 2: идёт обновление — в репо чужим процессам нельзя (probe: взяли лок — отпустили).
  if (cmd !== "mem") {
    const lock = acquireUpdateLock(ctx.deps.dataDir, "menu-svc");
    if (!lock.ok) {
      return ctx.flows.screen(st, T("⬆️ An update is in progress — try again after it finishes.",
        "⬆️ Идёт обновление — попробуй после его завершения."), [ctx.backRow("r")]);
    }
    releaseUpdateLock(lock);
  }
  const spec = await commandSpec(cmd, ctx);
  const over = ctx.deps.svcRun || {};
  const opts = {
    tg: ctx.tg, chatId: st.chatId, messageId: st.msgId, loader: LOADERS[cmd],
    attached: () => ctx.flows.get(st.chatId, st.userId) === st && st.screen === "svc",
    progressView: (run) => progressView(run, ctx),
    onFinish: async (run) => {
      // Итог рисуем, только если юзер всё ещё на экране svc — иначе сводка ждёт в render.
      if (!(ctx.flows.get(st.chatId, st.userId) === st && st.screen === "svc")) return;
      await ctx.tg("editMessageText", {
        chat_id: run.chatId, message_id: run.messageId, text: summaryText(run, ctx),
        reply_markup: { inline_keyboard: [[ctx.btn(ctx.tr("‹ Back", "‹ Назад"), "iva_menu:svc:o")]] },
      }).catch(() => {});
    },
    ...over,
  };
  const run = spec.kind === "unit" ? startUnit(cmd, spec, opts) : startProcess(cmd, spec, opts);
  if (!run) { // гонка: кто-то успел стартовать между гейтом и стартом
    const v = progressView(currentRun(), ctx);
    return ctx.flows.screen(st, T(`Already running:\n${v.text}`, `Уже идёт:\n${v.text}`), v.rows);
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
    if (verb === "go" && CMDS.has(args[0])) return startCommand(args[0], st, ctx);
    if (verb === "ab") {
      if (cancelRun()) return ctx.flows.screen(st, T("Stopping…", "Останавливаю…"), []);
      return ctx.show(st, "svc"); // нечего отменять — перерисовать текущее состояние
    }
    if (verb === "up") return ctx.deps.handleUpdateCheck?.(st.chatId);
  },
};
