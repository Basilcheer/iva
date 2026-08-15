import { randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import { DATA_DIR } from "./config.ts";

const OWNER_SCHEMA = "iva-telegram-poll-owner/v1";
const PROCESS_START_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-3]?[0-9] [0-2][0-9]:[0-5][0-9]:[0-6][0-9] [0-9]{4}$/u;
const HOLDER_READY = "IVA_TELEGRAM_LOCKED\n";
const HOLDER_SOURCE =
  `process.stdout.write(${JSON.stringify(HOLDER_READY)});` +
  "process.stdin.resume();" +
  "process.stdin.on('end',()=>process.exit(0));" +
  "process.stdin.on('error',()=>process.exit(0));";

export const TELEGRAM_PROCESS_LOCK_FILE = join(DATA_DIR, "telegram-poll.lock");
export const TELEGRAM_PROCESS_OWNER_FILE = join(
  DATA_DIR,
  "telegram-poll-owner.json",
);

export type TelegramProcessOwner = {
  schema: typeof OWNER_SCHEMA;
  pid: number;
  processStart: string;
  token: string;
};

export type TelegramProcessLease = {
  owner: TelegramProcessOwner;
  lockFile: string;
  holderPid: number;
  close(): Promise<void>;
};

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
    typeof parsed.token !== "string" ||
    !/^[0-9a-f]{32}$/u.test(parsed.token) ||
    Object.keys(parsed).length !== 4
  ) {
    throw new Error("invalid Telegram process owner schema");
  }
  return parsed as TelegramProcessOwner;
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
    ],
  };
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
  lockFileName = basename(TELEGRAM_PROCESS_LOCK_FILE),
  ownerFileName = basename(TELEGRAM_PROCESS_OWNER_FILE),
  pid = process.pid,
  token = randomUUID().replaceAll("-", ""),
  platform = process.platform,
  node = process.execPath,
  timeoutMs = 5_000,
  processStartImpl = readProcessStartIdentity,
  spawnImpl = spawn,
  writeOwnerImpl = (file: string, data: string) =>
    writeFileAtomic(file, data, { mode: 0o600 }),
  onLeaseLost = (error: Error) => {
    console.error("telegram-poll fatal:", error);
    process.exit(1);
  },
}: {
  dataDir?: string;
  lockFileName?: string;
  ownerFileName?: string;
  pid?: number;
  token?: string;
  platform?: NodeJS.Platform;
  node?: string;
  timeoutMs?: number;
  processStartImpl?: (pid: number) => string | null;
  spawnImpl?: SpawnImpl;
  writeOwnerImpl?: (file: string, data: string) => Promise<void>;
  onLeaseLost?: (error: Error) => void;
} = {}): Promise<TelegramProcessLease> {
  const processStart = processStartImpl(pid);
  if (processStart === null) {
    throw new Error(`cannot identify Telegram poll process PID ${pid}`);
  }
  const owner = parseTelegramProcessOwner(
    JSON.stringify({ schema: OWNER_SCHEMA, pid, processStart, token }),
  );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const physicalDataDir = await realpath(dataDir);
  const metadata = await stat(physicalDataDir, { bigint: true });
  const identity = { dev: metadata.dev, ino: metadata.ino };
  const lockFile = join(physicalDataDir, lockFileName);
  const ownerFile = join(physicalDataDir, ownerFileName);
  const command = lockCommand(lockFile, node, platform, timeoutMs);
  const child = spawnImpl(command.command, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childClosed = new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
  });
  let intentionalClose = false;
  let leaseActive = false;
  let holderExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  const holderExitError = (
    exit: { code: number | null; signal: NodeJS.Signals | null },
    phase: string,
  ) =>
    new Error(
      `Telegram process lock holder exited ${phase} (code=${String(exit.code)}, signal=${String(exit.signal)})`,
    );
  child.once("exit", (code, signal) => {
    holderExit = { code, signal };
    if (!intentionalClose && leaseActive) {
      onLeaseLost(holderExitError(holderExit, "unexpectedly"));
    }
  });
  const close = async (): Promise<void> => {
    if (intentionalClose) return;
    intentionalClose = true;
    child.stdin?.end();
    await childClosed;
  };
  try {
    await waitForLease(child, timeoutMs + 1_000);
    if (holderExit !== null) {
      throw holderExitError(holderExit, "during acquisition");
    }
    if (!(await sameDirectory(dataDir, physicalDataDir, identity))) {
      throw new Error(
        "Telegram process lock parent changed during acquisition",
      );
    }
    await writeOwnerImpl(ownerFile, `${JSON.stringify(owner)}\n`);
    if (holderExit !== null) {
      throw holderExitError(holderExit, "during acquisition");
    }
    if (!(await sameDirectory(dataDir, physicalDataDir, identity))) {
      throw new Error("Telegram process lock parent changed after owner write");
    }
  } catch (error) {
    await close();
    throw error;
  }
  if (child.pid === undefined) {
    await close();
    throw new Error("Telegram process lock holder has no PID");
  }
  if (holderExit !== null) {
    await close();
    throw holderExitError(holderExit, "during acquisition");
  }
  leaseActive = true;
  return { owner, lockFile, holderPid: child.pid, close };
}
