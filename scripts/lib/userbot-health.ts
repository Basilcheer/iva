import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataDir } from "./data-dir.ts";

export const USERBOT_HEALTH_TIMEOUT_MS = 1500;
export const USERBOT_SERVICE = "iva-telegram-userbot.service";

export type UserbotHealthState =
  "off" | "starting" | "unreachable" | "unauthorized" | "ready";

export interface UserbotHealth {
  readonly state: UserbotHealthState;
  readonly reason: string;
}

interface SystemctlResult {
  readonly code: number;
  readonly out: string;
}

interface HealthResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

interface HealthFetchInit {
  readonly method: "GET";
  readonly headers: { readonly authorization: string };
  readonly signal: AbortSignal;
}

type RunSystemctl = (
  args: string[],
  options: { signal?: AbortSignal },
) => Promise<SystemctlResult>;
type ReadToken = (dataDir: string) => Promise<string>;
type FetchImpl = (
  url: string,
  init: HealthFetchInit,
) => Promise<HealthResponse>;

interface ProbeOptions {
  readonly root?: string;
  readonly dataDir?: string;
  readonly port?: string | number;
  readonly timeoutMs?: number;
  readonly runSystemctl?: RunSystemctl;
  readonly readToken?: ReadToken;
  readonly fetchImpl?: FetchImpl;
}

function fixed(state: UserbotHealthState, reason: string): UserbotHealth {
  return { state, reason };
}

function defaultRunSystemctl(
  args: string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<SystemctlResult> {
  return new Promise((resolve) => {
    execFile(
      "systemctl",
      ["--user", ...args],
      { encoding: "utf8", signal },
      (error, stdout = "") => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          out: String(stdout).trim(),
        });
      },
    );
  });
}

async function defaultReadToken(dataDir: string): Promise<string> {
  try {
    return (
      await readFile(join(dataDir, "telegram-userbot.token"), "utf8")
    ).trim();
  } catch {
    return "";
  }
}

function payloadState(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const state = (payload as { state?: unknown }).state;
  return typeof state === "string" ? state : undefined;
}

interface RunProbeOptions {
  readonly dataDir: string;
  readonly port: string | number;
  readonly signal: AbortSignal;
  readonly runSystemctl: RunSystemctl;
  readonly readToken: ReadToken;
  readonly fetchImpl: FetchImpl;
}

async function runProbe({
  dataDir,
  port,
  signal,
  runSystemctl,
  readToken,
  fetchImpl,
}: RunProbeOptions): Promise<UserbotHealth> {
  const [active, enabled] = await Promise.all([
    runSystemctl(["is-active", USERBOT_SERVICE], { signal }),
    runSystemctl(["is-enabled", USERBOT_SERVICE], { signal }),
  ]);
  const activeLabel = String(active?.out || "").trim();
  const enabledLabel = String(enabled?.out || "").trim();
  const isActive = active?.code === 0 && activeLabel === "active";
  const isEnabled = enabled?.code === 0 && enabledLabel === "enabled";

  if (!isActive) {
    if (activeLabel === "activating" || isEnabled)
      return fixed("starting", "service_starting");
    return fixed("off", "service_off");
  }

  const token = String(await readToken(dataDir)).trim();
  if (!token) return fixed("unreachable", "proxy_token_missing");

  const safePort = /^\d{1,5}$/.test(String(port)) ? String(port) : "8724";
  const response = await fetchImpl(`http://127.0.0.1:${safePort}/healthz`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (response.status === 401)
    return fixed("unreachable", "proxy_auth_rejected");
  if (!response.ok) return fixed("unreachable", "proxy_unreachable");

  const state = payloadState(await response.json());
  if (state === "ready") return fixed("ready", "ok");
  if (state === "unauthorized")
    return fixed("unauthorized", "telegram_login_required");
  return fixed("unreachable", "invalid_proxy_response");
}

export async function probeUserbotHealth({
  root = process.cwd(),
  dataDir = resolveDataDir(root),
  port = process.env.TELEGRAM_MCP_PORT || "8724",
  timeoutMs = USERBOT_HEALTH_TIMEOUT_MS,
  runSystemctl = defaultRunSystemctl,
  readToken = defaultReadToken,
  fetchImpl = globalThis.fetch,
}: ProbeOptions = {}): Promise<UserbotHealth> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<UserbotHealth>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fixed("unreachable", "probe_timeout"));
    }, timeoutMs);
  });
  const probe = runProbe({
    dataDir,
    port,
    signal: controller.signal,
    runSystemctl,
    readToken,
    fetchImpl,
  }).catch(() =>
    controller.signal.aborted
      ? fixed("unreachable", "probe_timeout")
      : fixed("unreachable", "proxy_unreachable"),
  );

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
