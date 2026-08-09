import { spawn } from "node:child_process";
import { join } from "node:path";

const LOG_TAIL = 4000;
const BUSY_PORT = "the probe port was already answering";

/**
 * Whether a failed probe blames the port rather than the version.
 *
 * Two processes can pick the same free port between checking it and taking it,
 * and a health check that another server answers proves nothing at all - so this
 * verdict is worth another port, never a "the version does not start".
 */
export function portWasTaken(log: string): boolean {
  return log.includes(BUSY_PORT) || log.includes("EADDRINUSE");
}

async function answering(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
}

export type ProbeOptions = {
  /** The version directory, used both as cwd and as the source of the command. */
  readonly dir: string;
  readonly port: number;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly stopGraceMs?: number;
};

export type ProbeResult = { readonly ok: boolean; readonly log: string };

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a built version from its final directory and wait for it to answer.
 *
 * This is the only check that can tell "the build succeeded" apart from "the
 * service starts": the server bundles TypeScript from its own paths at startup,
 * so a staging-only check has repeatedly passed for a build that then crash-looped.
 */
export async function probeVersion({
  dir,
  port,
  command = process.execPath,
  args = [
    join(dir, "node_modules/eve/bin/eve.js"),
    "start",
    "--host",
    "127.0.0.1",
  ],
  env = {},
  timeoutMs = 90_000,
  intervalMs = 500,
  stopGraceMs = 5000,
}: ProbeOptions): Promise<ProbeResult> {
  // Asked before anything is started: whatever answers now cannot be the version,
  // and a check against it would pass for a build that never came up.
  if (await answering(port))
    return { ok: false, log: `${BUSY_PORT} on ${port}` };

  let log = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  const child = spawn(command, [...args], {
    cwd: dir,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: unknown) => {
    log = `${log}${String(chunk)}`.slice(-LOG_TAIL);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => {
    collect(`${error.message}\n`);
    exit = { code: 1, signal: null };
  });
  const stopped = new Promise<void>((resolve) =>
    child.on("close", (code, signal) => {
      exit ??= { code, signal };
      resolve();
    }),
  );

  const deadline = Date.now() + timeoutMs;
  let ok = false;
  while (!ok && !exit && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(Math.min(intervalMs * 4, 2000)),
      });
      ok = response.ok;
    } catch {
      // Not listening yet is the normal case for most of the startup window.
    }
    await wait(intervalMs);
    // Somebody else can still have taken the port in the meantime; the answer is
    // only the version's if the version is alive to have given it.
    if (ok && exit) ok = false;
  }

  // Captured before the shutdown below turns every run into an "exited" one.
  const crash = exit as { code: number | null; signal: string | null } | null;
  if (!crash) {
    child.kill("SIGTERM");
    // The port has to be free before the real service takes it, so escalate rather than hope.
    const killer = setTimeout(() => child.kill("SIGKILL"), stopGraceMs);
    await stopped;
    clearTimeout(killer);
  } else {
    await stopped;
  }
  if (ok) return { ok: true, log };
  const reason = crash
    ? `exited with code ${crash.code ?? "null"}${crash.signal ? ` (${crash.signal})` : ""}`
    : `did not become healthy on port ${port} within ${timeoutMs}ms`;
  return { ok: false, log: `${reason}\n${log}` };
}
