// Вход codex живёт в data/codex-auth.json установки (agent/lib/codex-auth.ts), а живой ход
// (scripts/live-turn.ts) поднимает Иву с пустой папкой данных: без копии файла codex
// отвечает «not logged in» на первом же шаге.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { forceRefreshAccessToken, jwtExp, readAuth } from "#lib/codex-auth.ts";

export const CODEX_NO_LOGIN = "codex: нет входа, iva login";

/** Сборка временной Ивы, ход до 240 с и запас обновления codex-auth (5 мин) — с избытком. */
const LIVE_TURN_TOKEN_MS = 30 * 60_000;

/**
 * Токен установки живёт меньше живого хода с запасом — он обновляется в самой установке, тем же
 * путём, что у сервиса и моста (`agent/lib/codex-auth.ts`). Иначе его обновила бы временная Ива в
 * своей копии: новый refresh-токен ушёл бы с песочницей, а у установки остался бы старый.
 */
async function renewForLiveTurn(
  dir: string,
  log: (line: string) => void,
): Promise<void> {
  const token = readAuth(dir)?.access_token;
  if (!token || jwtExp(token) * 1000 - Date.now() >= LIVE_TURN_TOKEN_MS) return;
  try {
    await forceRefreshAccessToken(dir);
  } catch (error) {
    // Сеть или 5xx на обновлении не роняют прогон: ход идёт с тем входом, что есть.
    log(
      `codex: не удалось обновить токен, копирую как есть: ${(error as Error).message}`,
    );
  }
}

/**
 * Копирует вход codex (0600) из данных установки в данные временной Ивы. `null` — копия
 * легла или провайдер не codex; строка — входа нет, ход не начинать.
 */
export async function carryCodexLogin(
  provider: string | undefined,
  fromData: string,
  toData: string,
  log: (line: string) => void = console.error,
): Promise<string | null> {
  if (provider !== "codex") return null;
  await renewForLiveTurn(fromData, log);
  let auth: Buffer;
  try {
    auth = await readFile(join(fromData, "codex-auth.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return CODEX_NO_LOGIN;
    throw error;
  }
  await writeFile(join(toData, "codex-auth.json"), auth, {
    mode: 0o600,
    flag: "wx",
  });
  return null;
}
