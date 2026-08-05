import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { acquireLock, loadJsonStrict, releaseLock, saveJsonAtomic } from "./json-store.ts";

export const TELEGRAM_MEDIA_CACHE_LIMIT = 500;

export type TelegramMediaCacheEntry = {
  path: string;
  vision?: string;
  transcript?: string;
  at: number;
};

type TelegramMediaCache = Record<string, TelegramMediaCacheEntry>;

type CacheOptions = {
  dataDir?: string;
  vaultDir?: string;
  log?: (message: string) => void;
};

const cacheFile = (dataDir = process.env.ASSISTANT_DATA_DIR ?? "data") =>
  join(dataDir, "media-cache.json");

function isEntry(value: unknown): value is TelegramMediaCacheEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    Number.isFinite(entry.at) &&
    (entry.vision === undefined || typeof entry.vision === "string") &&
    (entry.transcript === undefined || typeof entry.transcript === "string")
  );
}

function normalizeCache(value: unknown): TelegramMediaCache {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => key.length > 0 && isEntry(entry)),
  );
}

async function loadCache(file: string, log: (message: string) => void): Promise<TelegramMediaCache> {
  try {
    return normalizeCache(await loadJsonStrict<unknown>(file, {}));
  } catch (error) {
    const message = String((error as Error).message ?? error);
    if (!message.includes("damaged (invalid JSON)")) throw error;
    log(`[telegram] повреждённый media-cache пересоздан: ${message}`);
    return {};
  }
}

function resolvesToAttachment(entry: TelegramMediaCacheEntry, vaultDir: string): boolean {
  const attachments = resolve(vaultDir, "attachments");
  const target = resolve(vaultDir, entry.path);
  const inside = relative(attachments, target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return false;
  try {
    return existsSync(target) && statSync(target).isFile();
  } catch {
    return false;
  }
}

export async function getTelegramMediaCacheEntry(
  fileUniqueId: string,
  {
    dataDir = process.env.ASSISTANT_DATA_DIR ?? "data",
    vaultDir = process.env.ASSISTANT_VAULT_DIR ?? "vault",
    log = console.error,
  }: CacheOptions = {},
): Promise<TelegramMediaCacheEntry | null> {
  if (!fileUniqueId) return null;
  const file = cacheFile(dataDir);
  const lock = `${file}.lock`;
  const token = await acquireLock(lock);
  try {
    const entry = (await loadCache(file, log))[fileUniqueId];
    return entry && resolvesToAttachment(entry, vaultDir) ? entry : null;
  } finally {
    releaseLock(lock, token);
  }
}

export async function saveTelegramMediaCacheEntry(
  fileUniqueId: string,
  entry: TelegramMediaCacheEntry,
  {
    dataDir = process.env.ASSISTANT_DATA_DIR ?? "data",
    log = console.error,
  }: Omit<CacheOptions, "vaultDir"> = {},
): Promise<void> {
  if (!fileUniqueId || !isEntry(entry)) return;
  const file = cacheFile(dataDir);
  const lock = `${file}.lock`;
  const token = await acquireLock(lock);
  try {
    const current = await loadCache(file, log);
    const bounded = Object.entries({ ...current, [fileUniqueId]: entry })
      .sort(([, left], [, right]) => right.at - left.at)
      .slice(0, TELEGRAM_MEDIA_CACHE_LIMIT);
    await saveJsonAtomic(file, Object.fromEntries(bounded));
  } finally {
    releaseLock(lock, token);
  }
}
