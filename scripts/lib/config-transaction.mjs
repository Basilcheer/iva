import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseEnvText, writeEnvAtomicSync } from "./env-file.mjs";
import { validateModelSelection } from "./model-validation.mjs";

const JOURNAL_VERSION = 1;
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|BEARER|PASSWORD|HASH)$/;

export const pendingConfigPath = (envPath) =>
  `${envPath}.iva-config-transaction`;

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}
function secretValues(...texts) {
  const values = new Set();
  for (const text of texts) {
    for (const [key, value] of Object.entries(parseEnvText(text ?? ""))) {
      if (SECRET_KEY_RE.test(key) && value.length >= 4) values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redact(message, secrets) {
  let safe = String(message || "unknown failure");
  for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
  return safe.replace(/\s+/g, " ").slice(0, 500);
}

function durableRemove(path) {
  rmSync(path, { force: true });
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function snapshotOf(envPath) {
  const existed = existsSync(envPath);
  const oldText = existed ? readFileSync(envPath, "utf8") : "";
  return {
    version: JOURNAL_VERSION,
    existed,
    oldText,
    sha256: digest(oldText),
  };
}

function parseSnapshot(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error("pending configuration snapshot is invalid JSON", {
      cause,
    });
  }
  if (
    value?.version !== JOURNAL_VERSION ||
    typeof value.existed !== "boolean" ||
    typeof value.oldText !== "string" ||
    typeof value.sha256 !== "string" ||
    value.sha256 !== digest(value.oldText)
  ) {
    throw new Error("pending configuration snapshot is corrupt");
  }
  return value;
}

function restoreSnapshot(envPath, snapshot, writeEnv) {
  if (!snapshot.existed) {
    if (existsSync(envPath)) durableRemove(envPath);
    return;
  }
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  if (current !== snapshot.oldText) writeEnv(envPath, snapshot.oldText);
}

async function checkedRestart(restart, services) {
  const result = await restart(services);
  if (result === false) throw new Error("systemd restart returned failure");
}

export class ConfigTransactionError extends Error {
  constructor(message, { phase, rollbackFailed = false, cause } = {}) {
    super(message, { cause });
    this.name = "ConfigTransactionError";
    this.phase = phase;
    this.rollbackFailed = rollbackFailed;
  }
}

export async function probeEveHealth(
  url,
  {
    fetchFn = fetch,
    timeoutMs = 15_000,
    intervalMs = 250,
    now = Date.now,
    sleep,
  } = {},
) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
    parsed.pathname !== "/eve/v1/health"
  ) {
    throw new Error("health check must use the local /eve/v1/health route");
  }
  const wait =
    sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let lastStatus = null;
  do {
    try {
      const remaining = Math.max(1, deadline - now());
      const response = await fetchFn(parsed, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(2_000, remaining)),
      });
      lastStatus = response.status;
      if (response.ok) return;
    } catch {}
    if (now() < deadline)
      await wait(Math.min(intervalMs, Math.max(1, deadline - now())));
  } while (now() < deadline);
  throw Object.assign(
    new Error(
      lastStatus === null
        ? "local Eve health check timed out"
        : `local Eve health returned ${lastStatus}`,
    ),
    { code: "EHEALTH" },
  );
}

export async function recoverConfigTransaction(
  { envPath, services },
  {
    restart,
    writeEnv = writeEnvAtomicSync,
    removeJournal = durableRemove,
  } = {},
) {
  const journalPath = pendingConfigPath(envPath);
  if (!existsSync(journalPath)) return false;
  if (typeof restart !== "function")
    throw new TypeError("config recovery requires restart(services)");
  const snapshot = parseSnapshot(readFileSync(journalPath, "utf8"));
  const secrets = secretValues(snapshot.oldText);
  try {
    restoreSnapshot(envPath, snapshot, writeEnv);
    await checkedRestart(restart, services);
    removeJournal(journalPath);
    return true;
  } catch (cause) {
    throw new ConfigTransactionError(
      `Configuration recovery failed: ${redact(cause?.message, secrets)}. Fix systemd, then run \`iva config --recover\`.`,
      { phase: "recovery", rollbackFailed: true, cause },
    );
  }
}

export async function applyConfigTransaction(
  { envPath, nextText, selection, healthUrl, services },
  {
    validate = validateModelSelection,
    restart,
    health = probeEveHealth,
    writeEnv = writeEnvAtomicSync,
    writeJournal = writeEnvAtomicSync,
    removeJournal = durableRemove,
  } = {},
) {
  if (typeof restart !== "function")
    throw new TypeError("config transaction requires restart(services)");
  if (!Array.isArray(services) || services.length === 0) {
    throw new TypeError("config transaction requires at least one service");
  }
  if (typeof nextText !== "string")
    throw new TypeError("config transaction requires nextText");

  let phase = "validate";
  await validate(selection);

  const snapshot = snapshotOf(envPath);
  const secrets = secretValues(snapshot.oldText, nextText);
  const journalPath = pendingConfigPath(envPath);
  phase = "snapshot";
  writeJournal(journalPath, `${JSON.stringify(snapshot)}\n`);

  try {
    phase = "write";
    writeEnv(envPath, nextText);
    phase = "restart";
    await checkedRestart(restart, services);
    phase = "health";
    await health(healthUrl);
    phase = "commit";
    removeJournal(journalPath);
    return { committed: true };
  } catch (cause) {
    let rollbackCause = null;
    try {
      restoreSnapshot(envPath, snapshot, writeEnv);
      await checkedRestart(restart, services);
      removeJournal(journalPath);
    } catch (error) {
      rollbackCause = error;
    }

    const reason = redact(cause?.message, secrets);
    if (rollbackCause) {
      const rollbackReason = redact(rollbackCause?.message, secrets);
      throw new ConfigTransactionError(
        `Configuration apply failed during ${phase}: ${reason}. Rollback failed: ${rollbackReason}. The old snapshot is still pending; fix systemd, then run \`iva config --recover\`.`,
        { phase, rollbackFailed: true, cause },
      );
    }
    throw new ConfigTransactionError(
      `Configuration apply failed during ${phase}: ${reason}. Previous configuration restored.`,
      { phase, rollbackFailed: false, cause },
    );
  }
}
