// Runtime-переключаемые настройки UI, общие для моста (telegram-poll.mjs) и канала
// (agent/channels/telegram.ts): оба процесса читают/пишут ОДИН файл data/settings.json.
//
// Зачем отдельный файл, а не .env: язык интерфейса меняется кнопкой в /menu и должен
// применяться мгновенно, без рестарта, обоими процессами. Файл крошечный, пишем
// атомарно (fs-atomic.ts), чтобы читатель никогда не увидел полуфайл.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./fs-atomic.ts";

type Settings = Record<string, unknown>;

// Путь от cwd, а НЕ от import.meta.url: канал инлайнится в кэш authored-modules eve,
// откуда относительные пути указывают в node_modules/.cache (см. run-status.ts:14-18).
// Оба процесса (iva.service и мост) стартуют из одного WorkingDirectory (корень установки Ивы).
const DATA_DIR_RAW = process.env.ASSISTANT_DATA_DIR ?? "data";
const DATA_DIR = DATA_DIR_RAW.startsWith("/")
  ? DATA_DIR_RAW
  : join(process.cwd(), DATA_DIR_RAW);
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

// {} при отсутствии/битом файле — вызывающий код всегда получает объект.
export function readSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Settings)
      : {};
  } catch {
    return {};
  }
}

// Частичное обновление: patch мержится поверх текущего, null-поля удаляют ключ.
// Возвращает получившийся объект. Запись атомарна (tmp+rename).
export function writeSettings(patch: Settings): Settings {
  const next = { ...readSettings(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
  writeFileAtomicSync(SETTINGS_FILE, JSON.stringify(next));
  return next;
}
