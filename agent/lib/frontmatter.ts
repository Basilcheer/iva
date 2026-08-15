// Парсер/писатель YAML-frontmatter карточек vault'а. Порт правил из
// scripts/autograph/common.py (parse_frontmatter / write_frontmatter / format_field),
// чтобы тул и ночной пайплайн понимали ОДИН и тот же диалект:
//   • свёрнутые скаляры `description: >-` с продолжением на отступе (реальные карточки),
//   • литеральные блоки `|-`,
//   • блочные списки (`key:` + `- item`) и flow-списки `[a, b]`,
//   • перезапись ключа НЕ дублирует его старые continuation-строки (исторический баг
//     write_frontmatter, из-за которого description рос 2^N — не воспроизводить).
// Неизвестные ключи и их порядок сохраняются как есть: тул не знает про tier/relevance/
// last_accessed/phone/telegram и не имеет права их терять.

import { splitCard } from "./card-text.ts";

export type FmValue = string | string[];
export type FmFields = Record<string, FmValue>;

export interface ParsedFrontmatter {
  /** null — frontmatter отсутствует (тогда body === весь текст). */
  fields: FmFields | null;
  body: string;
  /** Исходные строки frontmatter (без ограничителей `---`) — нужны writeFrontmatter. */
  lines: string[];
}

/** Ожидаемая ошибка повреждённого frontmatter, которую caller может обработать. */
export class FrontmatterParseError extends Error {
  override readonly name = "FrontmatterParseError";
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const { frontmatter, body } = splitCard(content);
  if (frontmatter === null) return { fields: null, body, lines: [] };

  const rawLines = frontmatter.split("\n");
  const fields: Record<string, FmValue | null> = {};
  let multilineKey: string | null = null;
  let multilineMode: "fold" | "literal" | "list" | "pending" | null = null;
  let multilineSep = " ";
  let multilineBlankLines = 0;

  for (const line of rawLines) {
    const stripped = line.trim();
    // ЛЮБОЙ ведущий пробел/таб = continuation: YAML допускает и одиночный пробел.
    const indented = /^[ \t]/.test(line);

    // Пустая строка внутри block scalar разделяет абзацы и не завершает ключ.
    if (multilineKey && !stripped) {
      multilineBlankLines++;
      continue;
    }

    if (multilineKey && indented) {
      if (multilineMode === "pending") {
        if (stripped.startsWith("- ")) {
          multilineMode = "list";
          fields[multilineKey] = [];
        } else {
          multilineMode = "fold";
          multilineSep = " ";
          fields[multilineKey] = "";
        }
      }
      if (multilineMode === "list") {
        const item = stripped.startsWith("- ")
          ? stripped.slice(2).trim()
          : stripped;
        if (item) (fields[multilineKey] as string[]).push(unquote(item));
      } else {
        const prev = (fields[multilineKey] as string) || "";
        const separator = multilineBlankLines
          ? "\n".repeat(
              multilineBlankLines + (multilineMode === "literal" ? 1 : 0),
            )
          : multilineSep;
        fields[multilineKey] = (prev + separator + stripped).trim();
      }
      multilineBlankLines = 0;
      continue;
    }

    if (multilineKey && !indented) {
      if (fields[multilineKey] == null) fields[multilineKey] = "";
      multilineKey = null;
      multilineMode = null;
      multilineSep = " ";
      multilineBlankLines = 0;
    }

    if (!stripped || stripped.startsWith("#")) continue;
    const colon = stripped.indexOf(":");
    if (colon === -1) continue;

    const key = stripped.slice(0, colon).trim();
    const val = stripped.slice(colon + 1).trim();

    if (val === ">-" || val === ">") {
      multilineKey = key;
      multilineMode = "fold";
      multilineSep = " ";
      fields[key] = "";
      continue;
    }
    if (val === "|-" || val === "|") {
      multilineKey = key;
      multilineMode = "literal";
      multilineSep = "\n";
      fields[key] = "";
      continue;
    }
    if (val.startsWith(">")) {
      multilineKey = key;
      multilineMode = "fold";
      multilineSep = " ";
      fields[key] = val.replace(/^[>-]+/, "").trim();
      continue;
    }
    if (val.startsWith("|")) {
      multilineKey = key;
      multilineMode = "literal";
      multilineSep = "\n";
      fields[key] = val.replace(/^[|-]+/, "").trim();
      continue;
    }
    if (val === "") {
      multilineKey = key;
      multilineMode = "pending";
      multilineSep = " ";
      fields[key] = null;
      continue;
    }
    if (val.startsWith("[") && val.endsWith("]")) {
      // Квото-осознанный сплит: formatItem пишет `["a, b", c]` — наивный split(",")
      // разорвал бы квотированный элемент и сломал round-trip.
      const inner = val.slice(1, -1);
      fields[key] = inner.trim()
        ? splitFlowItems(inner).map((x) => unquote(x.trim()))
        : [];
    } else {
      fields[key] = unquote(val);
    }
  }

  if (multilineKey && fields[multilineKey] == null) fields[multilineKey] = "";

  const clean: FmFields = {};
  for (const [k, v] of Object.entries(fields)) clean[k] = v ?? "";
  return { fields: clean, body, lines: rawLines };
}

/** Элементы flow-списка `[...]` с учётом кавычек и экранированных `\"`. */
function splitFlowItems(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
        cur += inner[++i]; // экранированный символ внутри двойных кавычек
      } else if (ch === "'" && quote === "'" && inner[i + 1] === "'") {
        cur += inner[++i]; // YAML single quote escapes an apostrophe by doubling it
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (quote) {
    throw new FrontmatterParseError("unterminated quote in frontmatter flow list");
  }
  if (cur.trim().length || out.length) out.push(cur);
  return out;
}

function unquote(s: string): string {
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) {
      throw new FrontmatterParseError(
        "unterminated double-quoted frontmatter scalar",
      );
    }
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed === "string") return parsed;
    } catch (error) {
      throw new FrontmatterParseError(
        `invalid JSON-quoted frontmatter scalar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new FrontmatterParseError(
      "JSON-quoted frontmatter scalar is not a string",
    );
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) {
      throw new FrontmatterParseError(
        "unterminated single-quoted frontmatter scalar",
      );
    }
    const inner = s.slice(1, -1);
    let decoded = "";
    for (let index = 0; index < inner.length; index++) {
      if (inner[index] !== "'") {
        decoded += inner[index];
        continue;
      }
      if (inner[index + 1] !== "'") {
        throw new FrontmatterParseError(
          "single quote inside frontmatter scalar must be doubled",
        );
      }
      decoded += "'";
      index++;
    }
    return decoded;
  }
  return s;
}

/** Новый string всегда JSON-quoted: тип не меняется в любом YAML-reader. */
export function formatItem(v: string): string {
  return JSON.stringify(String(v));
}

export function formatField(key: string, val: FmValue): string {
  if (Array.isArray(val)) {
    return `${key}: ${JSON.stringify(val.map((item) => String(item)))}`;
  }
  return `${key}: ${formatItem(String(val))}`;
}

function valuesEqual(left: FmValue | undefined, right: FmValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

/**
 * Пересобрать frontmatter: порядок исходных строк сохраняется, значения известных
 * ключей заменяются, неизвестные строки остаются нетронутыми, новые ключи дописываются
 * в конец. Continuation-строки перезаписанного ключа пропускаются ПО ОТСТУПУ (не по
 * наличию двоеточия) — иначе `description: >-` дублируется на каждой перезаписи.
 */
export function writeFrontmatter(
  fields: FmFields,
  originalLines: string[],
): string {
  const originalFields = originalLines.length
    ? parseFrontmatter(`---\n${originalLines.join("\n")}\n---\n`).fields
    : null;
  const written = new Set<string>();
  const out: string[] = [];
  let skipContinuation = false;

  for (const line of originalLines) {
    const stripped = line.trim();
    const indented = /^[ \t]/.test(line);
    if (skipContinuation && indented) continue;

    if (!stripped || stripped.startsWith("#")) {
      // Пустая строка/коммент ВНУТРИ пропускаемого блока (folded-скаляр с абзацем) —
      // часть блока, не разделитель: не сбрасываем skip и не выводим.
      if (!skipContinuation) out.push(line);
      continue;
    }
    if (!stripped.includes(":")) {
      if (!skipContinuation) out.push(line);
      continue;
    }

    skipContinuation = false;
    const colon = stripped.indexOf(":");
    const key = stripped.slice(0, colon).trim();
    const valPart = stripped.slice(colon + 1).trim();
    written.add(key);
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      const unchanged = valuesEqual(originalFields?.[key], fields[key]);
      out.push(unchanged ? line : formatField(key, fields[key]));
      // '' покрывает блочные списки и pending-значения: их отступные строки тоже
      // заменяются целиком.
      if (!unchanged && [">-", ">", "|-", "|", ""].includes(valPart)) {
        skipContinuation = true;
      }
    } else {
      out.push(line);
    }
  }

  for (const [key, val] of Object.entries(fields)) {
    if (!written.has(key)) out.push(formatField(key, val));
  }

  return out.join("\n");
}
