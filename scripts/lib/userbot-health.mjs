import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const USERBOT_HEALTH_TIMEOUT_MS = 1500;
export const USERBOT_SERVICE = "iva-telegram-userbot.service";

function fixed(state, reason) {
  return { state, reason };
}

function defaultRunSystemctl(args, { signal } = {}) {
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

async function defaultReadToken(root) {
  try {
    return (await readFile(join(root, "data", "telegram-userbot.token"), "utf8")).trim();
  } catch {
    return "";
  }
}

async function runProbe({
  root,
  port,
  signal,
  runSystemctl,
  readToken,
  fetchImpl,
}) {
  const [active, enabled] = await Promise.all([
    runSystemctl(["is-active", USERBOT_SERVICE], { signal }),
    runSystemctl(["is-enabled", USERBOT_SERVICE], { signal }),
  ]);
  const activeLabel = String(active?.out || "").trim();
  const enabledLabel = String(enabled?.out || "").trim();
  const isActive = active?.code === 0 && activeLabel === "active";
  const isEnabled = enabled?.code === 0 && enabledLabel === "enabled";

  if (!isActive) {
    if (activeLabel === "activating" || isEnabled) return fixed("starting", "service_starting");
    return fixed("off", "service_off");
  }

  const token = String(await readToken(root)).trim();
  if (!token) return fixed("unreachable", "proxy_token_missing");

  const safePort = /^\d{1,5}$/.test(String(port)) ? String(port) : "8724";
  const response = await fetchImpl(`http://127.0.0.1:${safePort}/healthz`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (response.status === 401) return fixed("unreachable", "proxy_auth_rejected");
  if (!response.ok) return fixed("unreachable", "proxy_unreachable");

  const payload = await response.json();
  if (payload?.state === "ready") return fixed("ready", "ok");
  if (payload?.state === "unauthorized") return fixed("unauthorized", "telegram_login_required");
  return fixed("unreachable", "invalid_proxy_response");
}

export async function probeUserbotHealth({
  root = process.cwd(),
  port = process.env.TELEGRAM_MCP_PORT || "8724",
  timeoutMs = USERBOT_HEALTH_TIMEOUT_MS,
  runSystemctl = defaultRunSystemctl,
  readToken = defaultReadToken,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fixed("unreachable", "probe_timeout"));
    }, timeoutMs);
  });
  const probe = runProbe({
    root,
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
