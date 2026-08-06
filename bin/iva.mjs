#!/usr/bin/env node
// Iva CLI — manage the self-host installation: update / config / doctor / uninstall + wrappers.
// Self-contained, no external dependencies. Node 24+ (global fetch, spawnSync).
//
// SINGLE source of truth for systemd units and activation: install.sh delegates here
// (`iva _install-units` + `_activate-units`), and CLI/doctor reuse the same paths.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { modelSummary } from "../scripts/lib/model-summary.ts";
import { createTerminalProgress } from "../scripts/lib/progress.ts";
import { quarantinePath, resetStateTargets } from "../scripts/lib/wf-store.ts";
import {
  createTelegramUpdateReporter,
  loadTelegramJob,
  removeTelegramJob,
} from "../scripts/lib/telegram-status.ts";
import { userbotSyncArgs } from "../scripts/lib/userbot-deps.ts";
import { probeUserbotHealth } from "../scripts/lib/userbot-health.ts";
import {
  acquireUpdateLock,
  commitThenRunPostCommit,
  createUpdateLog,
  createUpdateTransaction,
  releaseUpdateLock,
} from "../scripts/lib/update-safety.ts";
import { createCliRuntime } from "../scripts/cli/runtime.ts";
import { createCliSystemd } from "../scripts/cli/systemd.ts";
import { createConfigCommand } from "../scripts/cli/config.ts";
import { createDoctorCommand } from "../scripts/cli/doctor.ts";

const runtime = createCliRuntime(
  join(dirname(fileURLToPath(import.meta.url)), ".."),
);
const cliSystemd = createCliSystemd(runtime);
const {
  ROOT,
  ENV_PATH,
  NPM,
  childEnv,
  SERVICES,
  UPDATE_TIMER,
  TIMERS,
  SVC_USERBOT,
  USERBOT_DIR,
  VENV_PY,
  TOKEN_FILE,
  DEFAULT_PORT,
  C,
  ok,
  warn,
  bad,
  step,
  run,
  cap,
  hasSystemd,
  systemd,
  gitHead,
  readEnv,
  dataDirAbs,
  confirm,
  requireSystemd,
  writeEnvVars,
} = runtime;
const { writeUnits, activateUnits, removeUnits, migrateEnv, restartServices } =
  cliSystemd;
const cmdConfig = createConfigCommand(runtime, cliSystemd);
const cmdDoctor = createDoctorCommand(runtime, cliSystemd);

// ANSI tree like during install. The only source of the art is install.sh (heredoc
// IVA_TREE); we read it from there so as not to spawn a copy. In a real terminal we add
// a little "life": the crown sways in the wind, colors shimmer, glyphs breathe slightly.
// Non-TTY / narrow window / IVA_NO_ANIM / any failure — a static frame (or nothing).
const TREE_RAMP = " .:;!icoa*xw#%$&@"; // the same set as the art generator

// Parse the heredoc into a grid of cells: {ch,r,g,b} for a colored glyph, {ch:" ",bg} for background.
function loadTreeGrid() {
  const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
  const body = sh.split("<<'IVA_TREE'\n")[1]?.split("\nIVA_TREE")[0];
  if (!body) return null;
  // eslint-disable-next-line no-control-regex -- The install art contains literal ANSI escape sequences.
  const re = /\x1b\[38;2;(\d+);(\d+);(\d+)m([\s\S])|\x1b\[0m|([\s\S])/g;
  return body
    .replace(/\\033/g, "\x1b")
    .split("\n")
    .map((line) => {
      const cells = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        if (m[4] !== undefined)
          cells.push({ ch: m[4], r: +m[1], g: +m[2], b: +m[3] });
        else if (m[5] !== undefined) cells.push({ ch: m[5], bg: true });
      }
      return cells;
    });
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// One frame. live=false → reference (no sway/shimmer) for the final resting state.
function renderTreeFrame(grid, t, live) {
  const rows = grid.length;
  let out = "";
  for (let y = 0; y < rows; y++) {
    const cells = grid[y];
    let lead = 0;
    while (lead < cells.length && cells[lead].bg) lead++;
    let last = cells.length - 1;
    while (last >= 0 && cells[last].bg) last--;
    // the tree stays still — only the glyphs and their colors come alive
    let line = " ".repeat(lead);
    for (let x = lead; x <= last; x++) {
      const c = cells[x];
      if (c.bg) {
        line += " ";
        continue;
      }
      let { r, g, b, ch } = c;
      if (live) {
        const shim = 1 + 0.16 * Math.sin(t * 0.6 + x * 0.45 + y * 0.3); // brightness shimmer
        r = clampByte(Math.round(r * shim));
        g = clampByte(Math.round(g * shim));
        b = clampByte(Math.round(b * shim));
        const idx = TREE_RAMP.indexOf(ch); // glyph breathes ±1 along the ramp (not into background)
        if (idx > 0)
          ch =
            TREE_RAMP[
              clamp(
                idx + Math.round(0.9 * Math.sin(t * 0.5 + x * 0.7 + y * 1.1)),
                1,
                TREE_RAMP.length - 1,
              )
            ];
      }
      line += `\x1b[38;2;${r};${g};${b}m${ch}`;
    }
    out += line + "\x1b[0m\x1b[K\n";
  }
  return out;
}

async function showTree() {
  if (
    !process.stdout.isTTY ||
    process.env.NO_COLOR ||
    process.env.TERM === "dumb"
  )
    return;
  let cursorHidden = false;
  const restoreCursor = () => {
    if (cursorHidden) process.stdout.write("\x1b[?25h");
    cursorHidden = false;
  };
  const signals = ["SIGINT", "SIGTERM"];
  const handlers = Object.fromEntries(
    signals.map((signal) => [
      signal,
      () => {
        restoreCursor();
        for (const name of signals)
          process.removeListener(name, handlers[name]);
        process.kill(process.pid, signal);
      },
    ]),
  );
  try {
    const grid = loadTreeGrid();
    if (!grid) return;
    const rows = grid.length;
    const width = Math.max(...grid.map((r) => r.length)) + 3;
    process.stdout.write("\n");
    // a narrow window breaks cursor-based redraw — show it statically
    if ((process.stdout.columns || 80) < width || process.env.IVA_NO_ANIM) {
      process.stdout.write(renderTreeFrame(grid, 0, false) + "\n");
      return;
    }
    process.stdout.write("\x1b[?25l"); // hide the cursor
    cursorHidden = true;
    for (const signal of signals) process.once(signal, handlers[signal]);
    const FRAMES = 36,
      DELAY = 70;
    for (let f = 0; f < FRAMES; f++) {
      if (f > 0) process.stdout.write(`\x1b[${rows}A`);
      process.stdout.write(renderTreeFrame(grid, f * 0.7, true));
      await new Promise((r) => setTimeout(r, DELAY));
    }
    process.stdout.write(`\x1b[${rows}A` + renderTreeFrame(grid, 0, false));
    restoreCursor();
    process.stdout.write("\n");
  } catch {
    restoreCursor();
  } finally {
    for (const signal of signals)
      process.removeListener(signal, handlers[signal]);
  }
}

// ── commands ───────────────────────────────────────────────────────────────
async function cmdUpdate(args) {
  const force = args.includes("--force");
  const verbose = args.includes("--verbose");
  const telegramJobAt = args.indexOf("--telegram-job");
  const telegramJobId = telegramJobAt >= 0 ? args[telegramJobAt + 1] || "" : "";
  const locale =
    (readEnv().AGENT_LANGUAGE || process.env.AGENT_LANGUAGE) === "ru"
      ? "ru"
      : "en";
  const text =
    locale === "ru"
      ? {
          protect: [
            "Сохраняю ваши изменения",
            "Изменения сохранены",
            "Не удалось сохранить изменения",
          ],
          fetch: [
            "Получаю обновление",
            "Обновление получено",
            "Не удалось получить обновление",
          ],
          build: ["Собираю Iva", "Iva собрана", "Не удалось собрать Iva"],
          timerFailure:
            "Iva готова, но таймер автоматических обновлений не удалось активировать",
          current: "Iva уже обновлена",
        }
      : {
          protect: [
            "Saving your changes",
            "Changes saved",
            "Couldn't save your changes",
          ],
          fetch: [
            "Getting the update",
            "Update received",
            "Couldn't get the update",
          ],
          build: ["Building Iva", "Iva built", "Couldn't build Iva"],
          timerFailure:
            "Iva is ready, but the automatic update timer could not be activated",
          current: "Iva is already up to date",
        };

  await showTree();
  const env = readEnv();
  const dataDir = dataDirAbs(env);
  const loadedJob = await loadTelegramJob(dataDir, telegramJobId);
  const reporter = loadedJob
    ? createTelegramUpdateReporter({
        token: env.TELEGRAM_BOT_TOKEN,
        job: loadedJob.job,
        env,
      })
    : null;
  const terminal = createTerminalProgress({ verbose });
  const owner = telegramJobId || `cli-${process.pid}-${Date.now()}`;
  const lock = acquireUpdateLock(dataDir, owner);
  if (!lock.ok) {
    terminal.fail(
      locale === "ru" ? "Обновление уже идёт" : "An update is already running",
    );
    reporter?.dispose();
    await removeTelegramJob(loadedJob?.path);
    process.exitCode = 1;
    return;
  }

  const logFile = createUpdateLog(dataDir);
  const tx = createUpdateTransaction({
    root: ROOT,
    dataDir,
    envPath: ENV_PATH,
    verbose,
    logFile,
    env: childEnv,
  });
  let phase = "protect";
  let userbotUpdateAttempted = false;
  let userbotRollbackSnapshot = null;
  let versions = {
    beforeVersion: "the previous version",
    afterVersion: "the new version",
  };
  const phaseStart = async (name) => {
    phase = name;
    terminal.start(text[name][0]);
    await reporter?.start(name);
  };
  const phaseDone = async (name) => {
    terminal.done(text[name][1]);
    await reporter?.done(name);
  };
  const ensureUpdateTimer = async () => {
    if (!hasSystemd()) return;
    writeUnits();
    systemd.activate([UPDATE_TIMER]);
  };
  const finalizeUpdate = async () => {
    const finalized = await commitThenRunPostCommit({
      commit: () => tx.commit(),
      postCommit: ensureUpdateTimer,
    });
    if (finalized.ok) return true;

    const detail = finalized.error?.message || String(finalized.error);
    terminal.fail(text.timerFailure);
    terminal.info(detail);
    await reporter?.postCommitFailure(detail);
    process.exitCode = 1;
    return false;
  };

  try {
    await phaseStart("protect");
    await tx.protect();
    await phaseDone("protect");

    await phaseStart("fetch");
    // Только fetch + классификация, HEAD не двигается: живая установка меняется лишь после
    // успешной сборки кандидата в worktree (см. buildCandidate в update-safety.ts).
    const update = await tx.resolveTarget();
    if (!update.changed && !force) {
      await tx.restoreLocalChanges();
      versions = await tx.versions();
      await phaseDone("fetch");
      if (!(await finalizeUpdate())) return;
      terminal.info(`✅ ${text.current} (${versions.afterVersion})`);
      await reporter?.complete({
        ...versions,
        changedLocal: tx.hadLocalChanges,
      });
      return;
    }
    await phaseDone("fetch");

    await phaseStart("build");
    const candidate = await tx.buildCandidate({ npm: NPM });
    const integrated = await tx.fetchAndIntegrate();
    await tx.restoreLocalChanges();
    versions = await tx.versions();
    migrateEnv({ quiet: true });
    // The streaming cleaner repairs cards the old frontmatter writer bloated to GBs (those
    // OOM-kill the agent and the nightly doctor, so waiting for the doctor is not an option).
    // The script comes from the freshly updated repo, so it is always the current version —
    // best-effort: it never fails an update.
    try {
      const vaultRel = readEnv().ASSISTANT_VAULT_DIR || "vault";
      const vaultDir = vaultRel.startsWith("/")
        ? vaultRel
        : join(ROOT, vaultRel);
      const cleanupScript = join(ROOT, "scripts/autograph/cleanup.py");
      const cleaned = spawnSync("uv", ["run", cleanupScript, ".", "--apply"], {
        cwd: vaultDir,
        encoding: "utf8",
        env: childEnv,
      });
      if (cleaned.status === 0 && !cleaned.stdout.includes(" 0 file(s)"))
        terminal.info(`🧹 ${cleaned.stdout.trim().split("\n").pop()}`);
    } catch {
      // Vault cleanup is best-effort and must not fail an update.
    }
    const promoted = candidate ? await tx.promoteCandidate() : false;
    if (!promoted) {
      if (integrated.changed) {
        const diff = await tx.git(
          "diff",
          "--name-only",
          `${versions.beforeHead}..${versions.afterHead}`,
        );
        const files = diff.stdout.split("\n");
        if (
          files.includes("package.json") ||
          files.includes("package-lock.json")
        ) {
          const install = await tx.run(NPM, [
            existsSync(join(ROOT, "package-lock.json")) ? "ci" : "install",
          ]);
          if (install.code !== 0)
            throw new Error("dependency installation failed");
        }
      }
      tx.backupOutput();
      const build = await tx.run(NPM, ["run", "build"]);
      if (build.code !== 0) throw new Error("build failed");
    }

    // Best-effort helper for an integration that has no active local service.
    await tx.run(NPM, ["i", "-g", "@googleworkspace/cli@latest"]);

    if (hasSystemd()) {
      writeUnits();
      systemd.restart(SERVICES);
      let healthy = false;
      const port = (readEnv().IVA_PORT || DEFAULT_PORT).trim();
      for (let attempt = 0; attempt < 30; attempt++) {
        const active = SERVICES.every((service) => systemd.isActive(service));
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(2000),
          });
          if (active && response.ok) {
            healthy = true;
            break;
          }
        } catch {
          // Transient health-check failures are retried until the deadline.
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!healthy) throw new Error("health check failed");
      if (systemd.isActive(SVC_USERBOT)) {
        const frozen = cap("uv", ["pip", "freeze", "--python", VENV_PY], {
          cwd: USERBOT_DIR,
        });
        if (frozen.code !== 0 || !frozen.out)
          throw new Error(
            "userbot: не удалось сохранить dependency snapshot перед обновлением",
          );
        userbotRollbackSnapshot = join(
          tmpdir(),
          `iva-userbot-before-update-${process.pid}-${Date.now()}.txt`,
        );
        writeFileSync(userbotRollbackSnapshot, `${frozen.out}\n`, {
          mode: 0o600,
        });
        userbotUpdateAttempted = true;
        restartUserbotIfActive({ quiet: true, knownActive: true });
      }
    }

    await phaseDone("build");
    if (!(await finalizeUpdate())) return;
    const model = modelSummary(readEnv());
    terminal.info(`✅ Iva ${locale === "ru" ? "обновлена" : "updated"}`);
    terminal.info(
      `${versions.beforeVersion} → ${versions.afterVersion} · ${model.provider}/${model.model}`,
    );
    await reporter?.complete({ ...versions, changedLocal: tx.hadLocalChanges });
  } catch (error) {
    terminal.fail(text[phase][2]);
    let rollbackOk = true;
    let codeRollbackOk = true;
    try {
      await tx.rollback();
    } catch {
      rollbackOk = false;
      codeRollbackOk = false;
    }
    // Пока живые .output/node_modules не тронуты (упал кандидат или интеграция),
    // здоровые сервисы не перезапускаем.
    if (phase === "build" && tx.outputTouched && hasSystemd()) {
      try {
        writeUnits();
        systemd.restart(SERVICES);
      } catch {
        rollbackOk = false;
      }
      if (userbotUpdateAttempted && codeRollbackOk) {
        try {
          restartUserbotIfActive({
            quiet: true,
            knownActive: true,
            requirementsPath: userbotRollbackSnapshot,
            requireHashes: false,
          });
        } catch {
          rollbackOk = false;
        }
      }
    }
    await reporter?.fail(phase, versions.beforeVersion);
    terminal.info(
      `${error.message}. ${locale === "ru" ? "Откат" : "Rollback"}: ${rollbackOk ? "OK" : "FAILED"}. ${locale === "ru" ? "Лог" : "Log"}: ${logFile}`,
    );
    process.exitCode = 1;
  } finally {
    try {
      await tx.teardownCandidate();
    } catch {
      // Candidate teardown is best-effort during final cleanup.
    }
    terminal.dispose();
    reporter?.dispose();
    releaseUpdateLock(lock);
    if (userbotRollbackSnapshot)
      rmSync(userbotRollbackSnapshot, { force: true });
    await removeTelegramJob(loadedJob?.path);
  }
}

function cmdStatus() {
  requireSystemd();
  run("systemctl", ["--user", "status", "--no-pager", "-n", "5", ...SERVICES]);
  run("systemctl", [
    "--user",
    "list-timers",
    "--no-pager",
    "iva-memory-*",
    UPDATE_TIMER,
  ]);
}
function cmdRestart() {
  requireSystemd();
  restartServices(); // regenerate the unit before restart → PORT stays in sync with IVA_PORT in .env
  ok("Restarted: iva + telegram-poll");
}
// Full reset: stop services, quarantine workflow + Telegram control state, bring it back up.
// A plain restart
// does NOT cure a stuck/bloated run — on startup eve re-enqueues all pending/running
// runs ("Re-enqueued N active run(s) on startup"). We clean while the server is stopped
// (otherwise we'd delete files out from under a live process). Wipes ALL parked dialogs.
// Current eve keeps the store in .eve/.workflow-data; the bare .workflow-data is where
// older versions kept it — clear both so reset works across eve upgrades. Busy markers and
// the bridge queue are part of the same transaction: neither may leak into a fresh workflow.
function cmdReset() {
  requireSystemd();
  step("Full reset: stopping services…");
  // Fail closed: quarantining the store under a live eve corrupts state and resurrects
  // the very runs we're clearing — if stop failed, don't touch anything.
  try {
    systemd.stop(SERVICES);
  } catch (e) {
    bad(`${e.message} Workflow and Telegram control state left untouched`);
    process.exit(1);
  }
  let found = false;
  let failed = false;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const target of resetStateTargets(ROOT, dataDirAbs())) {
    try {
      // Quarantine (rename → *.trash-<stamp>) instead of rm: undo-able until rotated out.
      const dest = quarantinePath(target, stamp);
      if (!dest) continue;
      found = true;
      ok(
        `${relative(ROOT, target)} → ${relative(ROOT, dest)} — reset state quarantined`,
      );
    } catch (e) {
      failed = true;
      warn(`failed to quarantine ${relative(ROOT, target)}: ${e.message}`);
    }
  }
  if (!found && !failed)
    ok("workflow and Telegram control state already empty");
  let restartError = null;
  try {
    restartServices();
  } catch (e) {
    restartError = e;
  }
  if (restartError) {
    bad(restartError.message);
  }
  if (failed)
    bad(
      "Reset INCOMPLETE — old workflow or Telegram control state may still be active",
    );
  if (failed || restartError) process.exit(1);
  ok("Restarted: iva + telegram-poll");
}
function cmdStart() {
  requireSystemd();
  activateUnits();
  ok("Started and enabled at boot");
}
function cmdStop() {
  requireSystemd();
  systemd.stop(SERVICES);
  ok("Stopped");
}
function cmdLogs(args) {
  requireSystemd();
  const unit = args.includes("poll")
    ? "iva-telegram-poll.service"
    : "iva.service";
  run("journalctl", ["--user", "-u", unit, "-f", "-n", "50"]);
}

async function cmdUninstall(args) {
  const purge = args.includes("--purge");
  warn(
    "Uninstalling Iva: systemd units and the `iva` command will be removed.",
  );
  if (purge)
    bad(
      "--purge will ALSO DELETE the project code and vault (a separate git repo with your memory!).",
    );
  if (!(await confirm("Continue?", false))) return console.log("Cancelled.");

  if (hasSystemd()) ok(`Removed systemd units: ${removeUnits().length}`);
  try {
    rmSync(join(homedir(), ".local/bin/iva"));
    ok("iva command removed from ~/.local/bin");
  } catch {
    // An already absent CLI symlink is a successful uninstall outcome.
  }

  if (!purge) {
    console.log(`${C.d}Code and vault kept: ${ROOT}${C.x}`);
    return ok("Done.");
  }
  if (
    !(await confirm(
      `Delete the ${ROOT} directory AND vault IRREVERSIBLY?`,
      false,
    ))
  )
    return console.log("Code and vault kept.");
  const vaultRel = readEnv().ASSISTANT_VAULT_DIR || "vault";
  const vaultPath = vaultRel.startsWith("/") ? vaultRel : join(ROOT, vaultRel);
  for (const [p, label] of [
    [vaultPath, "vault"],
    [ROOT, "code"],
  ]) {
    try {
      rmSync(p, { recursive: true, force: true });
      ok(`${label} deleted`);
    } catch (e) {
      warn(`did not delete ${label}: ${e.message}`);
    }
  }
}

function cmdVersion() {
  let v = "?";
  try {
    v = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  } catch {
    // Keep the fallback version marker when package metadata is unavailable.
  }
  console.log(`iva ${v} · commit ${gitHead() || "?"}`);
}

// Token usage from data/usage.jsonl — the same log that Telegram /usage reads. A terminal
// view (issue #7, the comment about a CLI monitor). `tail [N]` — the last raw lines.
async function cmdUsage(args) {
  const { readEntries, summarize, formatUsageReport, parseWindow } =
    await import("../scripts/lib/usage.ts");
  const env = readEnv();
  const dataDir = dataDirAbs(env);
  if (args[0] === "tail") {
    const n = Number(args[1]) || 10;
    for (const e of readEntries(dataDir).slice(-n))
      console.log(JSON.stringify(e));
    return;
  }
  const agg = summarize(readEntries(dataDir), {
    window: parseWindow(args[0]),
    now: Date.now(),
    tz: env.ASSISTANT_TIMEZONE,
  });
  console.log(formatUsageReport(agg));
}

// OpenAI subscription (ChatGPT) login — device code by default, --browser for the PKCE flow.
// Writes an OAuth token to data/codex-auth.json (0600); used when MODEL_PROVIDER=codex.
async function cmdLogin(args) {
  const { runDeviceCodeLogin, runBrowserLogin } =
    await import("../scripts/lib/codex-oauth.ts");
  const dataDir = dataDirAbs();
  const lang = (readEnv().AGENT_LANGUAGE || "en").toLowerCase();
  const browser = args.includes("--browser");
  step(browser ? "OpenAI sign-in (browser)…" : "OpenAI sign-in (device code)…");
  try {
    const auth = browser
      ? await runBrowserLogin({ dataDir, lang, log: (m) => console.log(m) })
      : await runDeviceCodeLogin({ dataDir, lang, log: (m) => console.log(m) });
    ok(
      `Signed in${auth.planType ? ` — plan: ${auth.planType}` : ""}${auth.accountId ? ` · account ${auth.accountId}` : ""}`,
    );
    console.log(
      `${C.d}Token stored: ${join(dataDir, "codex-auth.json")} (chmod 600)${C.x}`,
    );
    if (readEnv().MODEL_PROVIDER !== "codex")
      warn("Set MODEL_PROVIDER=codex to use it: iva config (then iva restart)");
  } catch (e) {
    bad(`Sign-in failed: ${e.message}`);
    process.exit(1);
  }
}

function cmdHelp() {
  console.log(`
${C.b}Iva CLI${C.x} — manage your personal agent

${C.b}Commands:${C.x}
  ${C.c}iva update${C.x}         update: git pull + build + restart
  ${C.c}iva config${C.x}         configure: model, Telegram, Deepgram, TZ, vault
  ${C.c}iva login${C.x} [--browser]  sign in to an OpenAI subscription (ChatGPT) for MODEL_PROVIDER=codex
  ${C.c}iva doctor${C.x}         diagnose and safely auto-repair the install
  ${C.c}iva status${C.x}         status of services and memory timers
  ${C.c}iva restart${C.x}        restart the agent and Telegram bridge
  ${C.c}iva reset${C.x}          full reset: clear stuck workflows and restart
  ${C.c}iva start${C.x} / ${C.c}stop${C.x}    start / stop
  ${C.c}iva usage${C.x} [win]      token usage (last|today|week|month|by-model|by-source|tail)
  ${C.c}iva userbot${C.x} [creds|setup|status|diagnose --json|off]  personal-account userbot proxy
  ${C.c}iva logs${C.x} [poll]     agent logs (or the Telegram bridge) -f
  ${C.c}iva uninstall${C.x}       remove units and the command (--purge — delete code+vault)
  ${C.c}iva version${C.x}         version and git commit

  ${C.d}flags: update --force — rebuild with no changes; update --verbose — show technical output${C.x}
`);
}

// ── router ──────────────────────────────────────────────────────────────────
// ── Telegram userbot (opt-in) ────────────────────────────────────────────
// Build the venv if missing and ALWAYS sync deps (idempotent), then verify the
// critical imports actually resolve. Throws on any failure so the caller aborts
// BEFORE enabling a service that would restart-loop on a partial install.
function ensureUserbotVenv({
  quiet = false,
  requirementsPath = join(USERBOT_DIR, "requirements.lock"),
  requireHashes = true,
} = {}) {
  const hasUv = !!cap("sh", ["-c", "command -v uv"]).out;
  if (!hasUv)
    throw new Error("userbot: uv не найден — повторно запусти install.sh");
  const opts = { cwd: USERBOT_DIR, ...(quiet ? { stdio: "ignore" } : {}) };
  const must = (r, what) => {
    if ((r?.status ?? 1) !== 0) throw new Error(`userbot: ${what} не удалось`);
  };
  if (!existsSync(VENV_PY)) {
    if (!quiet) step("Создаю venv для userbot-прокси…");
    must(
      run("uv", ["venv", "--python", "3.12", ".venv"], opts),
      "создание venv",
    );
    if (!existsSync(VENV_PY))
      throw new Error("userbot: venv не создан — проверь python3/uv");
  }
  if (!quiet) step("Синхронизирую зависимости userbot-прокси…");
  const requirements = readFileSync(requirementsPath, "utf8");
  must(
    run(
      "uv",
      userbotSyncArgs({
        pythonPath: VENV_PY,
        requirementsFile: requirementsPath,
        requirementsText: requirements,
        requireHashes,
      }),
      opts,
    ),
    "установка зависимостей",
  );
  // A partial install imports-fails at runtime → the service restart-loops silently.
  const check = cap(
    VENV_PY,
    ["-c", "import telethon, telegram_mcp, qrcode, mcp"],
    opts,
  );
  if (check.code !== 0)
    throw new Error(
      `userbot: зависимости не импортируются — ${check.err.split("\n").pop() || "проверь requirements"}`,
    );
}

// Generate the proxy bearer once, into a 0600 file both sides read at runtime.
function ensureUserbotToken() {
  if (existsSync(TOKEN_FILE)) return;
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, randomBytes(24).toString("hex"), { mode: 0o600 });
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // The token file is already created with mode 0600; chmod is best-effort.
  }
  ok("Сгенерировал токен прокси (data/telegram-userbot.token).");
}

// Restart the opt-in proxy onto fresh code/deps, but ONLY if it's already active
// (never auto-start it for users who didn't opt in). Called from `iva update`.
function restartUserbotIfActive({
  quiet = false,
  knownActive = false,
  requirementsPath = join(USERBOT_DIR, "requirements.lock"),
  requireHashes = true,
} = {}) {
  if (!knownActive && !systemd.isActive(SVC_USERBOT)) return;
  if (!quiet) step("Обновляю userbot-прокси…");
  ensureUserbotVenv({ quiet, requirementsPath, requireHashes });
  systemd.restart([SVC_USERBOT]);
  if (!quiet) ok("userbot-прокси перезапущен на новом коде");
}

async function cmdUserbot(args) {
  const sub = args[0] || "status";
  if (sub === "creds") {
    // Read api_id + api_hash from STDIN (two lines) — keeps secrets out of argv/ps.
    // Usage (agent): `iva userbot creds <<'CREDS'\n<api_id>\n<api_hash>\nCREDS`
    let data = "";
    try {
      data = readFileSync(0, "utf8");
    } catch {
      // Empty input falls through to the existing credential validation.
    }
    const [apiId, apiHash] = data
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!apiId || !apiHash) {
      bad(
        "stdin: жду две строки — api_id и api_hash (создай приложение на my.telegram.org)",
      );
      process.exit(1);
    }
    if (!/^\d+$/.test(apiId)) {
      bad("api_id должен быть числом");
      process.exit(1);
    }
    writeEnvVars({ TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash });
    ok("Ключи Telegram записаны в .env. Теперь: iva userbot setup");
    return;
  }
  if (sub === "setup") {
    const env = readEnv();
    if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
      bad(
        "Нет TELEGRAM_API_ID/TELEGRAM_API_HASH в .env. Создай приложение на my.telegram.org,",
      );
      bad("впиши оба ключа в .env и запусти снова: iva userbot setup");
      process.exit(1);
    }
    ensureUserbotToken(); // 0600 token file both the proxy and iva's connection read at runtime
    ensureUserbotVenv(); // throws → dispatch catches → exit 1, service NOT enabled
    writeUnits();
    systemd.activate([SVC_USERBOT]);
    // enable --now is idempotent and does not reload an already-active proxy.
    // Restart after syncing deps/writing the unit so fresh credentials and code are live.
    systemd.restart([SVC_USERBOT]);
    // NOTE: do NOT restart iva here — the agent runs this mid-chat, and iva reads the token
    // from the file at call time, so no restart is needed (Eve retries the MCP connection).
    ok(
      "Userbot-прокси включён. Подключи аккаунт по QR через бота: напиши боту «подключи мой телеграм».",
    );
    ok("Статус: iva userbot status · выключить: iva userbot off");
    return;
  }
  if (sub === "off") {
    systemd.disableNow([SVC_USERBOT]);
    ok("Userbot-прокси остановлен и выключен.");
    return;
  }
  if (sub === "diagnose") {
    if (args[1] !== "--json") {
      bad("Использование: iva userbot diagnose --json");
      process.exit(1);
    }
    const env = readEnv();
    const health = await probeUserbotHealth({
      root: ROOT,
      port: env.TELEGRAM_MCP_PORT || "8724",
    });
    console.log(JSON.stringify(health));
    return;
  }
  if (sub !== "status") {
    bad(`Неизвестная команда userbot: ${sub}`);
    process.exit(1);
  }
  const env = readEnv();
  const health = await probeUserbotHealth({
    root: ROOT,
    port: env.TELEGRAM_MCP_PORT || "8724",
  });
  console.log(`${SVC_USERBOT}: ${health.state}`);
  console.log(
    `venv: ${existsSync(VENV_PY) ? "собран" : "нет — будет собран при setup"}`,
  );
  console.log(
    `токен: ${existsSync(TOKEN_FILE) ? "есть" : "нет — создастся при setup"}`,
  );
}

const [, , cmd, ...rest] = process.argv;
const cmds = {
  update: cmdUpdate,
  userbot: cmdUserbot,
  config: cmdConfig,
  login: cmdLogin,
  doctor: cmdDoctor,
  status: cmdStatus,
  restart: cmdRestart,
  reset: cmdReset,
  usage: cmdUsage,
  start: cmdStart,
  stop: cmdStop,
  logs: cmdLogs,
  uninstall: cmdUninstall,
  version: cmdVersion,
  tree: showTree, // play the ANSI tree (wind animation)
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
  // Internal installer seams: one writer and the same checked activator used by
  // `iva start` and doctor. Success is printed only after every unit is enabled and active.
  "_install-units": () => ok(`systemd units written: ${writeUnits().length}`),
  "_activate-units": () => {
    activateUnits();
    ok(`systemd units enabled and active: ${SERVICES.length + TIMERS.length}`);
  },
};

const fn = cmds[cmd];
if (!fn) {
  if (cmd) bad(`Unknown command: ${cmd}`);
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(fn(rest)).catch((e) => {
  bad(e?.message || String(e));
  process.exit(1);
});
