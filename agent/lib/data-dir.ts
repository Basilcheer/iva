// Каталог данных Ивы — одна формула для authored и operational процессов.
//
// Путь берётся от cwd, а НЕ от import.meta.url: authored-модули инлайнятся в кэш eve,
// откуда относительные пути указывают в node_modules/.cache (см. run-status.ts:14-18).
// Все процессы установки (iva.service, мост telegram-poll.mjs) стартуют из одного
// WorkingDirectory — корня установки.
// Один локальный пакет доступен до npm ci и статически собирается Eve.
import { resolveDataDir } from "../../packages/data-dir/index.ts";
export { resolveDataDir };

export function dataDir(): string {
  return resolveDataDir(process.cwd(), process.env.ASSISTANT_DATA_DIR);
}
