// Thin spawner shared by agent/schedules/*.ts and scripts/lib/schedule-migration.mjs.
// Runs an existing cron script exactly the way the (now retired) systemd units did —
// `flock -w 900 <lockPath> <nodeBin> --env-file=.env <argv...>` — under a hard timeout,
// and records the outcome to a status file so `iva doctor` and the /menu → crons screen
// can see it. Never throws: eve's schedule runner and the fire-and-forget migration hook
// both need a promise that always settles.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

// A repeat within this window is almost certainly a double-fire (a Nitro schedule tick
// racing a catch-up run, or a manual retrigger) rather than a genuine second cron slot —
// none of the four periods fire more than once every 2h.
const GUARD_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3600_000;
const DEFAULT_KILL_GRACE_MS = 10_000;
const TAIL_MAX = 4000;
// The admission critical section below is a handful of synchronous fs calls — always
// microseconds. A lock still held after this long almost certainly means its owner
// crashed mid-section without cleanup, so it gets stolen once instead of wedging every
// future run of every schedule forever (this lock guards the shared status FILE, not
// one job — every name's admission check and finish-write goes through it).
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_ATTEMPTS = 25;
const LOCK_RETRY_DELAY_MS = 20;
const OWNER_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

function reservationOwnerIsDead(entry) {
  if (
    !Number.isSafeInteger(entry?.ownerPid) ||
    entry.ownerPid <= 0 ||
    typeof entry?.ownerStartedAt !== "number"
  ) {
    return false;
  }
  try {
    process.kill(entry.ownerPid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function ownsReservation(entry, startedAt) {
  return (
    entry?.inProgressSince === startedAt &&
    entry?.ownerPid === process.pid &&
    entry?.ownerStartedAt === OWNER_STARTED_AT
  );
}

// Shared with schedule-migration.mjs — one status file, one implementation of how it's
// safely read/written/locked, rather than two copies that could drift.
export function readStatus(statusPath) {
  try {
    const parsed = JSON.parse(readFileSync(statusPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStatusAtomic(statusPath, data) {
  mkdirSync(dirname(statusPath), { recursive: true });
  // Unique per call (pid + random), not a single shared "<statusPath>.tmp": two
  // concurrent writers (this schedule-runner call and, in principle, another one
  // whose withStatusLock retries were exhausted and proceeded unlocked) could
  // otherwise clobber each other's temp file mid-write, or one could unlink the
  // other's tmp file out from under an in-flight renameSync (ENOENT).
  const tmp = `${statusPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, statusPath);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // renameSync already consumed it on the success path — nothing left to remove
    }
  }
}

function tailLines(tail, n = 5) {
  return tail
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" | ");
}

// True mutual exclusion around a read-modify-write of the shared status file. Two
// runScheduledJob calls — a Nitro schedule tick and schedule-migration.mjs's catch-up
// firing at nearly the same instant is the concrete case this guards against — could
// otherwise both read the same pre-reservation status and both decide to proceed before
// either's write lands, since the tmp+rename write above is atomic per-write but doesn't
// by itself serialize the READ-THEN-DECIDE-THEN-WRITE sequence across two callers.
// O_EXCL (the "wx" flag) makes lock *acquisition* itself atomic. `fn` receives whether
// the lock was actually acquired — on the rare exhausted-retries path we still run `fn`
// (best-effort, logged by the caller) rather than leaving admission unchecked forever.
export async function withStatusLock(statusPath, fn) {
  const lockPath = `${statusPath}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS && !acquired; attempt++) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs >= LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue; // retry the create immediately, no delay needed
        }
      } catch {
        continue; // lock vanished between our failed create and the stat — retry now
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }
  try {
    return await fn(acquired);
  } finally {
    if (acquired) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // already gone — nothing to clean up
      }
    }
  }
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
  let reserved = false;
  let startedAt = now();
  try {
    if (statusPath) {
      const admitted = await withStatusLock(statusPath, (acquired) => {
        if (!acquired) {
          // Could not get exclusive access to the read-decide-write critical section in
          // time. Proceeding anyway would defeat the entire point of the lock — two
          // concurrent callers could both read the same pre-reservation snapshot and
          // both admit themselves, exactly the race this lock exists to close. Defer
          // instead: skip this attempt with no status write at all, and let the next
          // Nitro tick or migration boot retry — nothing unsafe happens meanwhile.
          log(
            `schedule-runner: ${name} could not acquire the status lock in time — deferring this attempt (retried on the next tick/boot)`,
          );
          return false;
        }
        const existing = readStatus(statusPath);
        const prior = existing[name];

        // Genuinely still running (started less than our own hard timeout ago) — a run
        // that hasn't succeeded OR failed yet, so the lastSuccessAt guard below can't
        // see it. Without this, a Nitro tick and a migration catch-up landing on the
        // same period at nearly the same instant would both read the same stale
        // lastSuccessAt and both pass that guard.
        if (
          typeof prior?.inProgressSince === "number" &&
          now() - prior.inProgressSince < timeoutMs &&
          !reservationOwnerIsDead(prior)
        ) {
          const ageS = Math.round((now() - prior.inProgressSince) / 1000);
          log(
            `schedule-runner: ${name} skipped — already in progress (started ${ageS}s ago)`,
          );
          return false;
        }
        if (
          typeof prior?.lastSuccessAt === "number" &&
          now() - prior.lastSuccessAt < guardMs
        ) {
          const ageMin = Math.round((now() - prior.lastSuccessAt) / 60000);
          log(
            `schedule-runner: ${name} skipped — last success ${ageMin}m ago (< ${Math.round(guardMs / 60000)}m guard)`,
          );
          return false;
        }

        startedAt = now();
        writeStatusAtomic(statusPath, {
          ...existing,
          [name]: {
            ...prior,
            lastStartedAt: startedAt,
            inProgressSince: startedAt,
            ownerPid: process.pid,
            ownerStartedAt: OWNER_STARTED_AT,
          },
        });
        reserved = true;
        return true;
      });
      if (!admitted) return { skipped: true, ok: true };
    } else {
      startedAt = now();
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
        child = spawnImpl(cmd, args, {
          cwd: root,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
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
      let hardTimer;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        // Only cancel a still-pending hard-kill when "child" exiting is proof the actual
        // TARGET process is gone — true for the direct (no lockPath) spawn, where child
        // literally is the schedule's own script, so leaving hardTimer dangling there would
        // risk it firing later against a since-reused pid. NOT true for the flock-wrapped
        // case: there "child" is flock itself, which — unlike the target it forks — has no
        // custom SIGTERM handler, so flock dying from the very SIGTERM we just sent proves
        // nothing about whether the grandchild node process (which still holds the lock) is
        // dead too. Canceling hardTimer there would orphan exactly the process this whole
        // group-kill exists to reach. (Caught this the hard way: an earlier, lockPath-blind
        // version of this cancellation left a real, unkillable orphan behind in this file's
        // own test suite.)
        if (!lockPath) clearTimeout(hardTimer);
        resolve(result);
      };

      const killTimer = setTimeout(() => {
        log(
          `schedule-runner: ${name} exceeded ${timeoutMs}ms — sending SIGTERM to its process group`,
        );
        killGroup("SIGTERM");
        hardTimer = setTimeout(() => {
          log(
            `schedule-runner: ${name} still running after SIGTERM — sending SIGKILL to its process group`,
          );
          killGroup("SIGKILL");
        }, killGraceMs);
        if (hardTimer.unref) hardTimer.unref();
      }, timeoutMs);
      if (killTimer.unref) killTimer.unref();

      child.on("error", (error) =>
        settle({ code: null, signal: null, tail, error }),
      );
      child.on("exit", (code, signal) => settle({ code, signal, tail }));
    });

    const finishedAt = now();
    const ok = outcome.code === 0 && !outcome.error;
    const codeDesc = outcome.code ?? "n/a";
    const signalDesc = outcome.signal ? `, signal=${outcome.signal}` : "";
    log(`schedule-runner: ${name} finished (code=${codeDesc}${signalDesc})`);
    if (outcome.tail)
      log(`schedule-runner: ${name} tail: ${tailLines(outcome.tail)}`);
    if (outcome.error)
      log(`schedule-runner: ${name} spawn error: ${outcome.error.message}`);

    if (statusPath) {
      const completed = await withStatusLock(statusPath, (acquired) => {
        if (!acquired) {
          log(
            `schedule-runner: ${name} could not acquire the status lock to record completion`,
          );
          return false;
        }
        const current = readStatus(statusPath);
        if (!ownsReservation(current[name], startedAt)) {
          log(
            `schedule-runner: ${name} completion ignored because its reservation changed owner`,
          );
          return false;
        }
        const {
          inProgressSince: _drop,
          ownerPid: _ownerPid,
          ownerStartedAt: _ownerStartedAt,
          ...rest
        } = current[name] ?? {};
        void _drop;
        void _ownerPid;
        void _ownerStartedAt;
        writeStatusAtomic(statusPath, {
          ...current,
          [name]: {
            ...rest,
            lastStartedAt: startedAt,
            lastFinishedAt: finishedAt,
            lastExitCode: outcome.code,
            ...(ok ? { lastSuccessAt: finishedAt } : {}),
          },
        });
        return true;
      });
      if (completed) reserved = false;
    }

    return { skipped: false, ok, code: outcome.code, signal: outcome.signal };
  } catch (error) {
    try {
      log(`schedule-runner: ${name} unexpected failure: ${error.message}`);
    } catch {
      // logging itself must never be able to throw out of this function
    }
    return { skipped: false, ok: false, error };
  } finally {
    // Belt-and-suspenders: if something threw between reserving and the normal
    // finish-write above (which already clears inProgressSince on every ordinary path),
    // don't leave the reservation stuck for the rest of timeoutMs for no reason.
    if (reserved && statusPath) {
      try {
        const cleaned = await withStatusLock(statusPath, (acquired) => {
          if (!acquired) {
            log(
              `schedule-runner: ${name} could not acquire the status lock to clear its reservation`,
            );
            return false;
          }
          const current = readStatus(statusPath);
          if (ownsReservation(current[name], startedAt)) {
            const {
              inProgressSince: _drop,
              ownerPid: _ownerPid,
              ownerStartedAt: _ownerStartedAt,
              ...rest
            } = current[name];
            void _drop;
            void _ownerPid;
            void _ownerStartedAt;
            writeStatusAtomic(statusPath, { ...current, [name]: rest });
          } else {
            log(
              `schedule-runner: ${name} cleanup ignored because its reservation changed owner`,
            );
            return false;
          }
          return true;
        });
        if (cleaned) reserved = false;
      } catch {
        // best-effort cleanup only — a stuck reservation still self-heals via the
        // inProgressSince/timeoutMs staleness check above on the next attempt.
      }
    }
  }
}
