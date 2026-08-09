import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const STALE_MS = 60 * 60 * 1000;

export type UpdateLock = { readonly path: string; release(): void };

function holder(path: string): { pid?: number; startedAt?: string } {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(path, "owner.json"), "utf8"),
    );
    return parsed ?? {};
  } catch {
    return {};
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Serialize updates with one atomic mkdir. A lock whose owner is gone is stale at
 * once - an update killed with SIGKILL must not block the retry that cleans up
 * after it - and the age fallback only covers a pid another program recycled.
 */
function own(path: string): UpdateLock {
  writeFileSync(
    join(path, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  return {
    path,
    // Only the process named in the lock may drop it, so a handoff cannot end with
    // the previous owner deleting the new owner's lock.
    release: () => {
      if (holder(path).pid === process.pid)
        rmSync(path, { recursive: true, force: true });
    },
  };
}

/**
 * Take over a held lock: the process that finishes the update owns it, so killing
 * the one that started it cannot make the lock look abandoned mid-flight.
 */
export function adoptUpdateLock(dataDir: string): UpdateLock {
  const path = join(dataDir, "update.lock");
  mkdirSync(path, { recursive: true });
  return own(path);
}

export function acquireUpdateLock(dataDir: string): UpdateLock | null {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "update.lock");
  const claim = (): UpdateLock => {
    mkdirSync(path);
    return own(path);
  };
  try {
    return claim();
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "EEXIST") throw caught;
  }
  const owner = holder(path);
  if (alive(owner.pid)) return null;
  if (!owner.pid) {
    // No readable owner: age is the only thing left that can tell live from abandoned.
    let age: number;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      return null;
    }
    if (age < STALE_MS) return null;
  }
  rmSync(path, { recursive: true, force: true });
  try {
    return claim();
  } catch {
    // Another retry won the race for the same abandoned lock.
    return null;
  }
}
