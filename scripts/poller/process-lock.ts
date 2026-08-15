import { createHash, randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import { BOT_USER_ID, DATA_DIR } from "./config.ts";

const OWNER_SCHEMA = "iva-telegram-poll-owner/v2";
const HOLDER_SCHEMA = "iva-telegram-poll-holder/v2";
const HOLDER_MARKER_PREFIX = "iva-telegram-poll-holder-v2=";
const PROCESS_START_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-3]?[0-9] [0-2][0-9]:[0-5][0-9]:[0-6][0-9] [0-9]{4}$/u;
const HOLDER_READY = "IVA_TELEGRAM_LOCKED\n";
const HOLDER_SOURCE =
  `process.stdout.write(${JSON.stringify(HOLDER_READY)});` +
  "process.stdin.resume();" +
  "process.stdin.on('end',()=>process.exit(0));" +
  "process.stdin.on('error',()=>process.exit(0));";

const processUid = typeof process.getuid === "function" ? process.getuid() : 0;
export const TELEGRAM_PROCESS_GUARD_BASE = join(
  "/tmp",
  `iva-telegram-poll-${processUid}`,
);

export const TELEGRAM_PROCESS_LOCK_FILE = join(DATA_DIR, "telegram-poll.lock");
export const TELEGRAM_PROCESS_OWNER_FILE = join(
  DATA_DIR,
  "telegram-poll-owner.json",
);

export type TelegramProcessOwner = {
  schema: typeof OWNER_SCHEMA;
  pid: number;
  processStart: string;
  nonce: string;
};

export type TelegramProcessLease = {
  owner: TelegramProcessOwner;
  botId: string;
  guardRoot: string;
  logicalGuardRoot: string;
  stateGuardRoot: string;
  lockFile: string;
  logicalLockFile: string;
  stateLockFile: string;
  guardOwnerFile: string;
  logicalGuardOwnerFile: string;
  stateGuardOwnerFile: string;
  holderPid: number;
  logicalHolderPid: number;
  stateHolderPid: number;
  close(): Promise<void>;
};

type GuardScope = "bot" | "logical" | "state";

export type TelegramGuardHolder = {
  schema: typeof HOLDER_SCHEMA;
  scope: GuardScope;
  identity: string;
  pid: number;
  processStart: string;
  nonce: string;
};

const activeLeases = new WeakSet<TelegramProcessLease>();

export function assertTelegramProcessLease(lease: TelegramProcessLease): void {
  if (!activeLeases.has(lease)) {
    throw new Error("Telegram startup requires an active process lease");
  }
}

type SpawnSyncImpl = (
  command: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
  },
) => SpawnSyncReturns<string>;
type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTelegramProcessOwner(raw: string): TelegramProcessOwner {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.schema !== OWNER_SCHEMA ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    typeof parsed.processStart !== "string" ||
    !PROCESS_START_PATTERN.test(parsed.processStart) ||
    typeof parsed.nonce !== "string" ||
    !/^[0-9a-f]{32}$/u.test(parsed.nonce) ||
    Object.keys(parsed).length !== 4
  ) {
    throw new Error("invalid Telegram process owner schema");
  }
  return parsed as TelegramProcessOwner;
}

function validBotId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
}

function validStateIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+:[0-9]+$/u.test(value);
}

function validLogicalIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function logicalDataDirIdentity(dataDir: string): string {
  return createHash("sha256")
    .update("iva-telegram-data-dir/v1\0")
    .update(resolve(dataDir))
    .digest("hex");
}

export function parseTelegramGuardHolderMarker(
  marker: string,
): TelegramGuardHolder {
  if (!marker.startsWith(HOLDER_MARKER_PREFIX)) {
    throw new Error("invalid Telegram guard holder marker");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(
        marker.slice(HOLDER_MARKER_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    );
  } catch {
    throw new Error("invalid Telegram guard holder marker");
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== HOLDER_SCHEMA ||
    (parsed.scope !== "bot" &&
      parsed.scope !== "logical" &&
      parsed.scope !== "state") ||
    !(
      (parsed.scope === "bot" && validBotId(parsed.identity)) ||
      (parsed.scope === "logical" && validLogicalIdentity(parsed.identity)) ||
      (parsed.scope === "state" && validStateIdentity(parsed.identity))
    ) ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    typeof parsed.processStart !== "string" ||
    !PROCESS_START_PATTERN.test(parsed.processStart) ||
    typeof parsed.nonce !== "string" ||
    !/^[0-9a-f]{32}$/u.test(parsed.nonce) ||
    Object.keys(parsed).length !== 6
  ) {
    throw new Error("invalid Telegram guard holder marker");
  }
  return parsed as TelegramGuardHolder;
}

function holderMarker(holder: TelegramGuardHolder): string {
  return `${HOLDER_MARKER_PREFIX}${Buffer.from(JSON.stringify(holder)).toString("base64url")}`;
}

export function readProcessStartIdentity(
  pid: number,
  spawnSyncImpl: SpawnSyncImpl = spawnSync,
): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSyncImpl(
    "/bin/ps",
    ["-o", "lstart=", "-p", String(pid)],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    },
  );
  if (result.error) throw result.error;
  const identity = result.stdout.trim().replace(/\s+/gu, " ");
  if (result.status !== 0) {
    if (!identity) return null;
    throw new Error(
      `/bin/ps failed while reading process ${pid}: ${result.stderr.trim()}`,
    );
  }
  if (!PROCESS_START_PATTERN.test(identity)) {
    throw new Error(`invalid process start identity for PID ${pid}`);
  }
  return identity;
}

function lockCommand(
  lockFile: string,
  node: string,
  platform: NodeJS.Platform,
  timeoutMs: number,
  marker: string,
): { command: string; args: string[] } {
  const waitSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  if (platform === "darwin") {
    return {
      command: "/usr/bin/lockf",
      args: [
        "-t",
        String(waitSeconds),
        lockFile,
        node,
        "--input-type=module",
        "-e",
        HOLDER_SOURCE,
        marker,
      ],
    };
  }
  const flock = ["/usr/bin/flock", "/bin/flock"].find(existsSync);
  if (!flock) throw new Error("Telegram process guard requires lockf or flock");
  return {
    command: flock,
    args: [
      "-w",
      String(waitSeconds),
      lockFile,
      node,
      "--input-type=module",
      "-e",
      HOLDER_SOURCE,
      marker,
    ],
  };
}

type LiveGuardHolder = { holderPid: number; holder: TelegramGuardHolder };

function liveGuardHolders(
  scope: GuardScope,
  identity: string,
  processStartImpl: (pid: number) => string | null,
  spawnSyncImpl: SpawnSyncImpl = spawnSync,
): LiveGuardHolder[] {
  const result = spawnSyncImpl(
    "/bin/ps",
    ["-axo", "pid=,ppid=,command=", "-ww"],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `/bin/ps failed while reading Telegram guard holders: ${result.stderr.trim()}`,
    );
  }
  const holders: LiveGuardHolder[] = [];
  for (const line of result.stdout.split("\n")) {
    const processLine = /^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/u.exec(line);
    if (!processLine) continue;
    const markerMatch = new RegExp(
      `(?:^|\\s)(${HOLDER_MARKER_PREFIX}[A-Za-z0-9_-]+)(?=\\s|$)`,
      "u",
    ).exec(processLine[3]);
    if (!markerMatch) continue;
    const holder = parseTelegramGuardHolderMarker(markerMatch[1]);
    if (holder.scope !== scope || holder.identity !== identity) continue;
    if (Number(processLine[2]) !== holder.pid) continue;
    if (processStartImpl(holder.pid) !== holder.processStart) continue;
    holders.push({ holderPid: Number(processLine[1]), holder });
  }
  return holders;
}

function guardOwnerHasLiveHolder(
  owner: TelegramProcessOwner,
  scope: GuardScope,
  identity: string,
  processStartImpl: (pid: number) => string | null,
  listImpl: (
    scope: GuardScope,
    identity: string,
    processStartImpl: (pid: number) => string | null,
  ) => LiveGuardHolder[],
): boolean {
  return listImpl(scope, identity, processStartImpl).some(
    ({ holder }) =>
      holder.pid === owner.pid &&
      holder.processStart === owner.processStart &&
      holder.nonce === owner.nonce,
  );
}

function assertNoOtherGuardHolder(
  scope: GuardScope,
  identity: string,
  ownNonce: string | null,
  processStartImpl: (pid: number) => string | null,
  listImpl: (
    scope: GuardScope,
    identity: string,
    processStartImpl: (pid: number) => string | null,
  ) => LiveGuardHolder[],
): void {
  const conflict = listImpl(scope, identity, processStartImpl).find(
    ({ holder }) => holder.nonce !== ownNonce,
  );
  if (conflict) {
    throw new Error(
      `Telegram poll process lock is held by active PID ${conflict.holder.pid}`,
    );
  }
}

export function telegramProcessOwnerIsLive(
  owner: TelegramProcessOwner,
  processStartImpl: (pid: number) => string | null = readProcessStartIdentity,
): boolean {
  return processStartImpl(owner.pid) === owner.processStart;
}

async function existingGuardOwner(
  file: string,
): Promise<TelegramProcessOwner | null> {
  try {
    return parseTelegramProcessOwner(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw new Error(`cannot verify Telegram guard owner ${file}`, {
      cause: error,
    });
  }
}

async function waitForLease(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolveLease, rejectLease) => {
    let output = "";
    let errors = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectLease(error);
      else resolveLease();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(HOLDER_READY)) finish();
    });
    child.stderr?.on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-2_000);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(
        new Error(
          `Telegram poll process lock is held by another owner (code=${String(code)}, signal=${String(signal)}${errors ? `: ${errors.trim()}` : ""})`,
        ),
      );
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("timed out acquiring Telegram process lock"));
    }, timeoutMs);
  });
}

async function sameDirectory(
  logical: string,
  physical: string,
  identity: { dev: bigint; ino: bigint },
): Promise<boolean> {
  const [mapped, metadata] = await Promise.all([
    realpath(logical),
    stat(physical, { bigint: true }),
  ]);
  return (
    mapped === physical &&
    metadata.dev === identity.dev &&
    metadata.ino === identity.ino
  );
}

export async function acquireTelegramProcessLock({
  dataDir = DATA_DIR,
  botId = BOT_USER_ID,
  guardBaseDir = TELEGRAM_PROCESS_GUARD_BASE,
  lockFileName = basename(TELEGRAM_PROCESS_LOCK_FILE),
  ownerFileName = basename(TELEGRAM_PROCESS_OWNER_FILE),
  pid = process.pid,
  nonce = randomUUID().replaceAll("-", ""),
  platform = process.platform,
  node = process.execPath,
  timeoutMs = 5_000,
  processStartImpl = readProcessStartIdentity,
  listGuardHoldersImpl = liveGuardHolders,
  spawnImpl = spawn,
  writeOwnerImpl = (file: string, data: string) =>
    writeFileAtomic(file, data, { mode: 0o600 }),
  onLeaseLost = (error: Error) => {
    console.error("telegram-poll fatal:", error);
    process.exit(1);
  },
}: {
  dataDir?: string;
  botId?: string | null;
  guardBaseDir?: string;
  lockFileName?: string;
  ownerFileName?: string;
  pid?: number;
  nonce?: string;
  platform?: NodeJS.Platform;
  node?: string;
  timeoutMs?: number;
  processStartImpl?: (pid: number) => string | null;
  listGuardHoldersImpl?: (
    scope: GuardScope,
    identity: string,
    processStartImpl: (pid: number) => string | null,
  ) => LiveGuardHolder[];
  spawnImpl?: SpawnImpl;
  writeOwnerImpl?: (file: string, data: string) => Promise<void>;
  onLeaseLost?: (error: Error) => void;
} = {}): Promise<TelegramProcessLease> {
  if (!validBotId(botId)) {
    throw new Error("Telegram process guard requires a numeric bot identity");
  }
  const processStart = processStartImpl(pid);
  if (processStart === null) {
    throw new Error(`cannot identify Telegram poll process PID ${pid}`);
  }
  const owner = parseTelegramProcessOwner(
    JSON.stringify({ schema: OWNER_SCHEMA, pid, processStart, nonce }),
  );
  await mkdir(guardBaseDir, { recursive: true, mode: 0o700 });
  const guardBaseMetadata = await lstat(guardBaseDir);
  if (
    !guardBaseMetadata.isDirectory() ||
    (typeof process.getuid === "function" &&
      guardBaseMetadata.uid !== process.getuid()) ||
    (guardBaseMetadata.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Telegram process guard base is not a private owned directory",
    );
  }
  type HolderExit = {
    code: number | null;
    signal: NodeJS.Signals | null;
  };
  type AcquiredGuard = {
    scope: GuardScope;
    identity: string;
    root: string;
    lockFile: string;
    ownerFile: string;
    child: ChildProcess;
    childClosed: Promise<void>;
    exit: HolderExit | null;
  };

  let intentionalClose = false;
  let leaseActive = false;
  let lease: TelegramProcessLease | null = null;
  const guards: AcquiredGuard[] = [];
  const holderExitError = (exit: HolderExit, phase: string) =>
    new Error(
      `Telegram process lock holder exited ${phase} (code=${String(exit.code)}, signal=${String(exit.signal)})`,
    );
  const assertAllHoldersAlive = (phase: string): void => {
    const exited = guards.find((guard) => guard.exit !== null);
    if (exited?.exit) throw holderExitError(exited.exit, phase);
  };
  const close = async (): Promise<void> => {
    if (intentionalClose) return;
    intentionalClose = true;
    leaseActive = false;
    if (lease !== null) activeLeases.delete(lease);
    for (const guard of guards) guard.child.stdin?.end();
    await Promise.all(guards.map((guard) => guard.childClosed));
  };

  const acquireGuard = async (
    scope: GuardScope,
    identity: string,
  ): Promise<AcquiredGuard> => {
    // The live process marker is independent of every mutable filesystem
    // pathname. It keeps the scope singular after guard-root, lock, or owner
    // replacement; the kernel lock linearizes normal concurrent first use.
    assertNoOtherGuardHolder(
      scope,
      identity,
      null,
      processStartImpl,
      listGuardHoldersImpl,
    );
    const directoryName =
      scope === "state"
        ? `state-${identity.replace(":", "-")}`
        : `${scope}-${identity}`;
    const logicalRoot = join(guardBaseDir, directoryName);
    await mkdir(logicalRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(logicalRoot);
    const metadata = await stat(root, { bigint: true });
    const rootIdentity = { dev: metadata.dev, ino: metadata.ino };
    const lockFile = join(root, lockFileName);
    const ownerFile = join(root, ownerFileName);
    const holder = parseTelegramGuardHolderMarker(
      holderMarker({
        schema: HOLDER_SCHEMA,
        scope,
        identity,
        pid,
        processStart,
        nonce,
      }),
    );
    const command = lockCommand(
      lockFile,
      node,
      platform,
      timeoutMs,
      holderMarker(holder),
    );
    const child = spawnImpl(command.command, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const guard: AcquiredGuard = {
      scope,
      identity,
      root,
      lockFile,
      ownerFile,
      child,
      childClosed: new Promise<void>((resolveClose) => {
        child.once("close", () => resolveClose());
      }),
      exit: null,
    };
    guards.push(guard);
    child.once("exit", (code, signal) => {
      guard.exit = { code, signal };
      const wasActive = leaseActive;
      leaseActive = false;
      if (lease !== null) activeLeases.delete(lease);
      if (!intentionalClose && wasActive) {
        onLeaseLost(holderExitError(guard.exit, "unexpectedly"));
      }
    });

    await waitForLease(child, timeoutMs + 1_000);
    if (guard.exit !== null) {
      throw holderExitError(guard.exit, "during acquisition");
    }
    if (child.pid === undefined) {
      throw new Error("Telegram process lock holder has no PID");
    }
    assertNoOtherGuardHolder(
      scope,
      identity,
      nonce,
      processStartImpl,
      listGuardHoldersImpl,
    );
    if (!(await sameDirectory(logicalRoot, root, rootIdentity))) {
      throw new Error(
        `Telegram process ${scope} guard root changed during acquisition`,
      );
    }
    const previousOwner = await existingGuardOwner(ownerFile);
    if (previousOwner !== null && previousOwner.nonce !== nonce) {
      const liveProcess = telegramProcessOwnerIsLive(
        previousOwner,
        processStartImpl,
      );
      const matchingHolder = guardOwnerHasLiveHolder(
        previousOwner,
        scope,
        identity,
        processStartImpl,
        listGuardHoldersImpl,
      );
      if (liveProcess && (previousOwner.pid !== pid || matchingHolder)) {
        throw new Error(
          `Telegram poll process lock is held by active PID ${previousOwner.pid}`,
        );
      }
    }
    await writeOwnerImpl(ownerFile, `${JSON.stringify(owner)}\n`);
    assertAllHoldersAlive("during acquisition");
    if (!(await sameDirectory(logicalRoot, root, rootIdentity))) {
      throw new Error(
        `Telegram process ${scope} guard root changed after owner write`,
      );
    }
    const publishedOwner = await existingGuardOwner(ownerFile);
    if (
      publishedOwner === null ||
      JSON.stringify(publishedOwner) !== JSON.stringify(owner)
    ) {
      throw new Error(
        `Telegram process ${scope} guard owner changed after publication`,
      );
    }
    assertNoOtherGuardHolder(
      scope,
      identity,
      nonce,
      processStartImpl,
      listGuardHoldersImpl,
    );
    return guard;
  };

  let botGuard: AcquiredGuard;
  let logicalGuard: AcquiredGuard;
  let stateGuard: AcquiredGuard;
  try {
    botGuard = await acquireGuard("bot", botId);

    // The normalized configured path is hashed before any DATA_DIR I/O. This
    // keeps one logical state root singular if a symlink is retargeted, without
    // leaking the configured path in ps output or a guard pathname.
    logicalGuard = await acquireGuard(
      "logical",
      logicalDataDirIdentity(dataDir),
    );

    // Physical identity additionally makes distinct symlink aliases to the
    // same state conflict. The fixed scope order avoids acquisition cycles.
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const physicalDataDir = await realpath(dataDir);
    const metadata = await stat(physicalDataDir, { bigint: true });
    const dataIdentity = { dev: metadata.dev, ino: metadata.ino };
    const stateIdentity = `${metadata.dev.toString()}:${metadata.ino.toString()}`;
    stateGuard = await acquireGuard("state", stateIdentity);
    assertAllHoldersAlive("during acquisition");
    if (!(await sameDirectory(dataDir, physicalDataDir, dataIdentity))) {
      throw new Error("Telegram process state root changed during acquisition");
    }
    const ownerFile = join(physicalDataDir, ownerFileName);
    await writeOwnerImpl(ownerFile, `${JSON.stringify(owner)}\n`);
    assertAllHoldersAlive("during acquisition");
    if (!(await sameDirectory(dataDir, physicalDataDir, dataIdentity))) {
      throw new Error("Telegram process state root changed after owner write");
    }
  } catch (error) {
    await close();
    throw error;
  }
  assertAllHoldersAlive("during acquisition");
  if (
    botGuard.child.pid === undefined ||
    logicalGuard.child.pid === undefined ||
    stateGuard.child.pid === undefined
  )
    throw new Error("Telegram process lock holder has no PID");
  lease = {
    owner,
    botId,
    guardRoot: botGuard.root,
    logicalGuardRoot: logicalGuard.root,
    stateGuardRoot: stateGuard.root,
    lockFile: botGuard.lockFile,
    logicalLockFile: logicalGuard.lockFile,
    stateLockFile: stateGuard.lockFile,
    guardOwnerFile: botGuard.ownerFile,
    logicalGuardOwnerFile: logicalGuard.ownerFile,
    stateGuardOwnerFile: stateGuard.ownerFile,
    holderPid: botGuard.child.pid,
    logicalHolderPid: logicalGuard.child.pid,
    stateHolderPid: stateGuard.child.pid,
    close,
  };
  leaseActive = true;
  activeLeases.add(lease);
  return lease;
}
