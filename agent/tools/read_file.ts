import { defineTool } from "eve/tools";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// Host-native чтение файла. Переопределяет встроенный read_file eve: читает реальный
// файл на VPS через node:fs/promises (UTF-8). Самодостаточно (eve/tools, zod, node-builtins).
//
// КОНТРАКТ ПУТЕЙ (общий с memory_search): memory_search отдаёт hits[].file как путь
// ОТНОСИТЕЛЬНО корня vault (cards/contacts/x.md) и в описании велит открывать хиты этим
// тулом — поэтому read_file принимает и абсолютный путь, и vault-относительный, резолвя
// последний от ASSISTANT_VAULT_DIR. Иначе модель получала ENOENT на путь, который ей же
// и выдали. Не менять в одностороннем порядке.

const VAULT = () => process.env.ASSISTANT_VAULT_DIR || "vault";

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : resolve(VAULT(), path);
}

// Потолок вывода: большой файл не должен переполнять окно контекста за один ход.
const MAX_CHARS = 24000;
const cap = (s: string) =>
  s.length > MAX_CHARS
    ? { content: s.slice(0, MAX_CHARS) + "\n…(усечено; используй offset/limit для остального)", capped: true }
    : { content: s, capped: false };

export default defineTool({
  description:
    "Прочитать UTF-8 файл НАПРЯМУЮ с файловой системы хоста VPS. " +
    "Путь — абсолютный ИЛИ относительный от корня vault (так возвращает memory_search). " +
    "По умолчанию возвращает всё содержимое; можно ограничить диапазон строк " +
    "через offset (номер первой строки, 1-based) и limit (число строк). " +
    "Возвращает { path, content, lines, truncated }.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Абсолютный путь к файлу на хосте либо путь относительно корня vault (hits[].file)"),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Номер первой возвращаемой строки (1-based)"),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Максимальное число строк для чтения"),
  }),
  async execute({ path, offset, limit }) {
    const raw = await readFile(resolvePath(path), "utf8");

    // Без offset/limit — отдаём файл целиком (с потолком по символам).
    if (offset === undefined && limit === undefined) {
      const { content, capped } = cap(raw);
      return {
        path,
        content,
        lines: raw.length === 0 ? 0 : raw.split("\n").length,
        truncated: capped,
      };
    }

    const allLines = raw.split("\n");
    const start = offset ? offset - 1 : 0;
    const end = limit ? start + limit : allLines.length;
    const slice = allLines.slice(start, end);
    const { content, capped } = cap(slice.join("\n"));
    return {
      path,
      content,
      lines: slice.length,
      truncated: capped || end < allLines.length || start > 0,
    };
  },
});
