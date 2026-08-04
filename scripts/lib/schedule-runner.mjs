// Thin spawner shared by agent/schedules/*.ts and scripts/lib/schedule-migration.mjs.
// Runs an existing cron script exactly the way the (now retired) systemd units did —
// `flock -w 900 <lockPath> <nodeBin> --env-file=.env <argv...>` — under a hard timeout,
// and records the outcome to a status file so `iva doctor` and the /menu → crons screen
// can see it. Never throws: eve's schedule runner and the fire-and-forget migration hook
// both need a promise that always settles.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A repeat within this window is almost certainly a double-fire (a Nitro schedule tick
// racing a catch-up run, or a manual retrigger) rather than a genuine second cron slot —
// none of the four periods fire more than once every 2h.
const GUARD_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3600_000;
const DEFAULT_KILL_GRACE_MS = 10_000;
const TAIL_MAX = 4000;

function readStatus(statusPath) {
  try {
    const parsed = JSON.parse(readFileSync(statusPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeStatusAtomic(statusPath, data) {
  mkdirSync(dirname(statusPath), { recursive: true });
  const tmp = `${statusPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, statusPath);
}

function tailLines(tail, n = 5) {
  return tail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).join(" | ");
}

export async function runScheduledJob({
  name,
  argv,
  root,
  nodeBin,
  lockPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  guardMs = GUARD_MS,
  statusPath,
  env = process.env,
  spawnImpl = spawn,
  killImpl = (pid, signal) => process.kill(pid, signal),
  now = () => Date.now(),
  log = (...a) => console.log(new Date().toISOString(), ...a),
} = {}) {
  try {
    const existing = statusPath ? readStatus(statusPath) : {};
    const prior = existing[name];
    if (typeof prior?.lastSuccessAt === "number" && now() - prior.lastSuccessAt < guardMs) {
      const ageMin = Math.round((now() - prior.lastSuccessAt) / 60000);
      log(`schedule-runner: ${name} skipped — last success ${ageMin}m ago (< ${Math.round(guardMs / 60000)}m guard)`);
      return { skipped: true, ok: true };
    }

    const startedAt = now();
    if (statusPath) {
      writeStatusAtomic(statusPath, { ...existing, [name]: { ...prior, lastStartedAt: startedAt } });
    }
    log(`schedule-runner: ${name} start`);

    const cmd = lockPath ? "flock" : nodeBin;
    const args = lockPath
      ? ["-w", "900", lockPath, nodeBin, "--env-file=.env", ...argv]
      : ["--env-file=.env", ...argv];

    const outcome = await new Promise((resolve) => {
      let child;
      try {
        // detached: true makes the child the leader of its OWN process group (POSIX
        // setpgid) instead of sharing ours. That matters specifically for the flock-
        // wrapped case: flock fork()s node as its child, and that fork inherits the
        // flock()'d file descriptor — the lock is held by the OPEN FILE DESCRIPTION,
        // not by whichever process id we happen to signal. Killing only flock's own
        // pid on timeout left node (and the lock) alive. Signaling the whole process
        // group (killImpl(-pid, ...) below) reaches flock AND the node it forked.
        child = spawnImpl(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      } catch (error) {
        resolve({ code: null, signal: null, tail: "", error });
        return;
      }

      let tail = "";
      const onData = (chunk) => {
        tail = (tail + chunk.toString()).slice(-TAIL_MAX);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      // Signal the process GROUP (negative pid), not just this one pid — see the
      // detached:true comment above. Falls back to a direct child.kill if the group
      // signal fails for any reason (e.g. the child already reaped its own group).
      const killGroup = (signal) => {
        const pid = child.pid;
        try {
          if (pid) killImpl(-pid, signal);
          else child.kill(signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // process may have exited between the timer firing and the kill call
          }
        }
      };

      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve(result);
      };

      const killTimer = setTimeout(() => {
        log(`schedule-runner: ${name} exceeded ${timeoutMs}ms — sending SIGTERM to its process group`);
        killGroup("SIGTERM");
        const hardTimer = setTimeout(() => {
          log(`schedule-runner: ${name} still running after SIGTERM — sending SIGKILL to its process group`);
          killGroup("SIGKILL");
        }, killGraceMs);
        if (hardTimer.unref) hardTimer.unref();
      }, timeoutMs);
      if (killTimer.unref) killTimer.unref();

      child.on("error", (error) => settle({ code: null, signal: null, tail, error }));
      child.on("exit", (code, signal) => settle({ code, signal, tail }));
    });

    const finishedAt = now();
    const ok = outcome.code === 0 && !outcome.error;
    const codeDesc = outcome.code ?? "n/a";
    const signalDesc = outcome.signal ? `, signal=${outcome.signal}` : "";
    log(`schedule-runner: ${name} finished (code=${codeDesc}${signalDesc})`);
    if (outcome.tail) log(`schedule-runner: ${name} tail: ${tailLines(outcome.tail)}`);
    if (outcome.error) log(`schedule-runner: ${name} spawn error: ${outcome.error.message}`);

    if (statusPath) {
      const current = readStatus(statusPath);
      writeStatusAtomic(statusPath, {
        ...current,
        [name]: {
          ...current[name],
          lastStartedAt: startedAt,
          lastFinishedAt: finishedAt,
          lastExitCode: outcome.code,
          ...(ok ? { lastSuccessAt: finishedAt } : {}),
        },
      });
    }

    return { skipped: false, ok, code: outcome.code, signal: outcome.signal };
  } catch (error) {
    try {
      log(`schedule-runner: ${name} unexpected failure: ${error.message}`);
    } catch {
      // logging itself must never be able to throw out of this function
    }
    return { skipped: false, ok: false, error };
  }
}
