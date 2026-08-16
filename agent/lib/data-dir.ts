// Каталог данных ивы — одна формула на всех, кто его считает.
//
// Путь берётся от cwd, а НЕ от import.meta.url: authored-модули инлайнятся в кэш eve,
// откуда относительные пути указывают в node_modules/.cache (см. run-status.ts:14-18).
// Все процессы установки (iva.service, мост telegram-poll.mjs) стартуют из одного
// WorkingDirectory — корня установки.
import { join } from "node:path";

export function dataDir(): string {
  const raw = process.env.ASSISTANT_DATA_DIR ?? "data";
  return raw.startsWith("/") ? raw : join(process.cwd(), raw);
}
