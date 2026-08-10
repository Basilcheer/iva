// Surgical .env editor for the Telegram bridge (/model, /think).
// Unlike scripts/setup/main.ts's writeEnv (full rewrite in a fixed key order, drops comments),
// this edits lines in place: comments, blank lines, unknown keys and order survive.
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { throughLink } from "./version-layout.ts";

// Lazy value capture + trailing \s*: tolerates CRLF files (a greedy .* would keep the \r).
const LINE_RE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;

type EnvValues = Record<string, string>;

interface AtomicWriteHooks {
  beforeRename?: (temporaryPath: string) => void;
  beforeDirectorySync?: (parentPath: string) => void;
}

interface DurabilityError extends Error {
  code: "EENV_DURABILITY";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === code;
}

/** Parse .env text → {KEY: value}; surrounding quotes stripped (same regex as setup/main.ts). */
export function parseEnvText(text: unknown): EnvValues {
  const env: EnvValues = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** Read .env into {KEY: value}; {} when the file is missing. */
export async function readEnvValues(path: string): Promise<EnvValues> {
  try {
    return parseEnvText(await readFile(path, "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return {};
    throw error;
  }
}

// Base env refreshed with the current .env file: file values win, base-only keys survive.
// For long-running processes (the Telegram bridge) whose process.env snapshot goes stale
// after the /model wizard edits .env — display code must read through this, not process.env.
export async function readEnvFresh(
  path: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  return { ...base, ...(await readEnvValues(path)) };
}

/**
 * Replace an env file atomically.
 *
 * The old file is protected before any secret is staged. The replacement is a
 * unique 0600 file in the same directory. The file is fsynced before rename,
 * then the parent directory is fsynced so the rename survives a crash.
 */
export function writeEnvAtomicSync(
  linkOrPath: string,
  text: unknown,
  { beforeRename, beforeDirectorySync }: AtomicWriteHooks = {},
): void {
  // A version directory borrows `.env` from the installation through a symlink,
  // and a rename replaces the link rather than following it - which would turn
  // shared configuration into a copy that the next update drops.
  const path = throughLink(linkOrPath);
  if (existsSync(path)) chmodSync(path, 0o600);
  const parent = dirname(path);
  const tmp = join(
    parent,
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    const fileFd = openSync(tmp, "wx", 0o600);
    try {
      fchmodSync(fileFd, 0o600);
      writeFileSync(fileFd, String(text), "utf8");
      fsyncSync(fileFd);
    } finally {
      closeSync(fileFd);
    }
    beforeRename?.(tmp);
    renameSync(tmp, path);

    try {
      beforeDirectorySync?.(parent);
      const directoryFd = openSync(parent, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (cause) {
      const error = new Error(
        `env file was replaced, but parent directory fsync failed; new bytes are live and crash durability is unconfirmed: ${(cause as Error).message}`,
        { cause },
      ) as DurabilityError;
      error.code = "EENV_DURABILITY";
      throw error;
    }
  } catch (error) {
    try {
      rmSync(tmp);
    } catch {
      // Failure to remove a missing or inaccessible temp file must preserve the original error.
    }
    throw error;
  }
}

// Upsert keys in .env: updates = {KEY: string | null} (null ⇒ drop the line).
// First matching line is replaced in place, duplicates are dropped, missing keys are
// appended at the end. Values must be single-line — a multiline paste (e.g. a mangled
// API key) must fail loudly here, not corrupt .env. Write is atomic (tmp + rename),
// and every resulting .env is 0600 because it holds secrets.
export async function upsertEnv(
  path: string,
  updates: Record<string, string | null>,
): Promise<void> {
  for (const [k, v] of Object.entries(updates)) {
    if (v != null && /[\n\r]/.test(String(v)))
      throw new Error(`env value for ${k} contains a newline`);
  }
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    /* no file yet - create from scratch */
  }
  const lines = text.length ? text.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline re-added below
  const pending = new Map<string, string | null>(
    Object.entries(updates).map(([k, v]) => [
      k,
      v == null ? null : String(v).trim(),
    ]),
  );
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(LINE_RE);
    const k = m?.[1];
    if (k && pending.has(k)) {
      const v = pending.get(k)!;
      pending.delete(k); // duplicates of the same key are dropped
      if (v !== null) out.push(`${k}=${v}`);
      continue;
    }
    // A later duplicate of an already-handled deleted/replaced key: pending no longer has it — drop.
    if (k && k in updates && !pending.has(k)) continue;
    out.push(line);
  }
  for (const [k, v] of pending) if (v !== null) out.push(`${k}=${v}`);
  writeEnvAtomicSync(path, out.join("\n") + "\n");
}
