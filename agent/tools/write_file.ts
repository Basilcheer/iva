import { defineTool } from "eve/tools";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

// Host-native запись файла. Переопределяет встроенный write_file eve: пишет реальный
// файл на VPS через node:fs/promises, создавая родительские директории (mkdir -p).
// Самодостаточно (eve/tools, zod, node-builtins).
//
// Единственное ограничение: перезапись СУЩЕСТВУЮЩЕЙ карточки в <vault>/cards/** запрещена —
// это полная замена файла, из-за которой терялись поля (tier/relevance/phone…) и старый текст.
// Такие правки идут через write_card (он сливает). Всё остальное (vault/CORE.md, daily,
// новые файлы в cards/) write_file пишет как раньше — см. instructions/10-map.md.

const VAULT = () => process.env.ASSISTANT_VAULT_DIR || "vault";

function isExistingCard(path: string): boolean {
  const cards = resolve(VAULT(), "cards");
  const abs = resolve(path);
  if (abs !== cards && !abs.startsWith(cards + sep)) return false;
  return existsSync(abs);
}

export default defineTool({
  description:
    "Записать файл НАПРЯМУЮ на файловую систему хоста VPS (UTF-8). " +
    "Родительские директории создаются автоматически (mkdir -p). " +
    "Перезаписывает файл целиком. Возвращает { ok, path, bytes }. " +
    "ИСКЛЮЧЕНИЕ: существующую карточку в vault/cards/** перезаписывать нельзя — используй write_card.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Абсолютный путь к файлу на хосте"),
    content: z.string().describe("Содержимое для записи (UTF-8)"),
  }),
  async execute({ path, content }) {
    if (isExistingCard(path)) {
      return {
        ok: false,
        path,
        error:
          "Карточка уже существует — write_file затёр бы её целиком (поля вне схемы и старый текст). " +
          "Используй write_card: он сливает новое содержимое со старым.",
      };
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return { ok: true, path, bytes: Buffer.byteLength(content, "utf8") };
  },
});
