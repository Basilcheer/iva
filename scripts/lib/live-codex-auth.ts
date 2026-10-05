// Вход codex живёт в data/codex-auth.json установки (agent/lib/codex-auth.ts), а живой ход
// (scripts/live-turn.ts) поднимает Иву с пустой папкой данных: без копии файла codex
// отвечает «not logged in» на первом же шаге.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CODEX_NO_LOGIN = "codex: нет входа, iva login";

/**
 * Копирует вход codex (0600) из данных установки в данные временной Ивы. `null` — копия
 * легла или провайдер не codex; строка — входа нет, ход не начинать.
 */
export async function carryCodexLogin(
  provider: string | undefined,
  fromData: string,
  toData: string,
): Promise<string | null> {
  if (provider !== "codex") return null;
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
