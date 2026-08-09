import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvText } from "./env-file.ts";

const LOG_TAIL = 4000;
/** Set for the probe only; the code that runs on boot reads it to stay passive. */
export const PROBE_FLAG = "IVA_HEALTH_PROBE";
const BUSY_PORT = "the probe port was already answering";

/** Whether a failed probe blames the port rather than the version: retry higher. */
export function portWasTaken(log: string): boolean {
  return log.includes(BUSY_PORT) || log.includes("EADDRINUSE");
}

/** Whatever answers on the port, or null when nothing does in time. */
async function answering(port: number, ms = 1000): Promise<Response | null> {
  try {
    const url = `http://127.0.0.1:${port}/`;
    return await fetch(url, { signal: AbortSignal.timeout(ms) });
  } catch {
    return null;
  }
}

export type ProbeOptions = {
  /** The version directory: both the cwd and the source of the command. */
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

/**
 * The environment the service is started with, adjusted for a probe. systemd hands
 * the unit the `.env`, so a probe without it proves a version starts under a
 * configuration nobody runs. The port is the probe's own in both spellings, or
 * code reaching for `IVA_PORT` would talk to the live service. The state
 * directories are the version's own, because that `.env` is free to name absolute
 * paths - and then every write of a start that is about to be thrown away would
 * land in the live installation instead of the probe's scratch.
 */
export function probeEnvironment(
  envPath: string,
  port: number,
  dir: string,
): Record<string, string> {
  let values: Record<string, string> = {};
  try {
    values = parseEnvText(readFileSync(envPath, "utf8"));
  } catch {
    // A missing .env is a valid state; an unreadable one is the service's to report.
  }
  return {
    ...values,
    ASSISTANT_DATA_DIR: join(dir, "data"),
    ASSISTANT_VAULT_DIR: join(dir, "vault"),
    PORT: String(port),
    IVA_PORT: String(port),
    [PROBE_FLAG]: "1",
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a built version from its final directory and wait for it to answer. This is
 * the only check that tells "the build succeeded" apart from "the service starts":
 * the server bundles TypeScript from its own paths at startup, so a staging-only
 * check has repeatedly passed for a build that then crash-looped.
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
  // Whatever answers before anything is started cannot be the version.
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
  const collect = (chunk: unknown): void => {
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
    ok = (await answering(port, Math.min(intervalMs * 4, 2000)))?.ok ?? false;
    await wait(intervalMs);
    if (ok && exit) ok = false; // The answer is only the version's if it is alive.
  }

  // Captured before the shutdown below turns every run into an "exited" one.
  const crash = exit as { code: number | null; signal: string | null } | null;
  if (crash) await stopped;
  else {
    child.kill("SIGTERM");
    // The port has to be free before the real service takes it: escalate, do not hope.
    const killer = setTimeout(() => child.kill("SIGKILL"), stopGraceMs);
    await stopped;
    clearTimeout(killer);
  }
  if (ok) return { ok: true, log };
  const reason = crash
    ? `exited with code ${crash.code ?? "null"}${crash.signal ? ` (${crash.signal})` : ""}`
    : `did not become healthy on port ${port} within ${timeoutMs}ms`;
  return { ok: false, log: `${reason}\n${log}` };
}
