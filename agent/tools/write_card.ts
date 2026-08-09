import { defineTool } from "eve/tools";
import { z } from "zod";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  acquireLock,
  atomicWrite,
  hasH2Section,
  mergeCard,
  resolveCard,
} from "../lib/card-store.js";

// Строго типизированная запись карточки памяти. Заменяет «write_file по наитию» для карточек:
// zod-enum на type/status берётся из autograph schema.json (единый источник правды), поэтому
// модель НЕ может выдумать тип или добавить неизвестное поле — вызов упадёт на валидации.
// Ночной enforce.py остаётся backstop'ом для всего, что записалось мимо этого тула.

const VAULT = () => process.env.ASSISTANT_VAULT_DIR || "vault";

// Типы карточек, которые модель создаёт интерактивно (summary-типы пишет ночной rollup, не тул).
const CARD_TYPE_DIR: Record<string, string> = {
  contact: "contacts",
  project: "projects",
  decision: "decisions",
  idea: "ideas",
  note: "notes",
};
const DESC_CAP = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    result[key] = item;
  }
  return result;
}

// Схема vault'а: корень vault'а → легаси `.claude`-путь (vault'ы до 0.3.3) → дефолт из репо.
function schemaPath(): string {
  const candidates = [
    join(VAULT(), "schema.json"),
    join(VAULT(), ".claude", "skills", "autograph", "schema.json"),
    join("scripts", "autograph", "schema.example.json"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

// Читаем схему на старте: валидные статусы per-type + алиасы. Fallback — зашитый минимум,
// чтобы тул не падал, если vault ещё не инициализирован.
function loadSchema(): {
  status: Record<string, string[]>;
  aliases: Record<string, string>;
} {
  const fallback: {
    status: Record<string, string[]>;
    aliases: Record<string, string>;
  } = {
    status: {
      contact: ["active", "inactive"],
      project: ["active", "done", "paused", "cancelled", "draft"],
      decision: ["active", "superseded", "reverted"],
      idea: ["active", "explored", "archived", "draft"],
      note: ["active", "draft", "archived"],
    },
    aliases: {
      person: "contact",
      company: "contact",
      thought: "note",
      proposal: "idea",
    },
  };
  try {
    const raw = readFileSync(schemaPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    const nodeTypes = isRecord(parsed.node_types)
      ? parsed.node_types
      : undefined;
    const status: Record<string, string[]> = {};
    for (const t of Object.keys(CARD_TYPE_DIR)) {
      const node = nodeTypes?.[t];
      const configured = isRecord(node)
        ? isStringArray(node.status)
          ? node.status
          : isStringArray(node.statuses)
            ? node.statuses
            : undefined
        : undefined;
      status[t] = configured ?? fallback.status[t] ?? ["active"];
    }
    return {
      status,
      aliases: asStringRecord(parsed.type_aliases) ?? fallback.aliases,
    };
  } catch {
    return fallback;
  }
}

const SCHEMA = loadSchema();
const CARD_TYPES = Object.keys(CARD_TYPE_DIR) as [string, ...string[]];

// Алиасы типов из схемы применяются ДО валидации: описание поля обещает person/company →
// contact, значит z.enum не должен отклонять их раньше execute. Алиасы, ведущие в типы вне
// CARD_TYPE_DIR (daily → daily-summary), не разворачиваются — их пишет ночной rollup.
function normalizeType(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase();
  if (k in CARD_TYPE_DIR) return k;
  const mapped = SCHEMA.aliases[k];
  return mapped && mapped in CARD_TYPE_DIR ? mapped : k;
}

// Транслитерация не нужна — vault хранит кириллические слаги нормально (см. существующие карточки).
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.ASSISTANT_TIMEZONE || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default defineTool({
  description:
    "Создать или обновить типизированную карточку памяти в vault. Явно выбери " +
    "ADD, UPDATE, SUPERSEDE или NOOP; без operation старые вызовы определяются автоматически. " +
    "Используй ЭТО (не write_file) " +
    "для карточек — гарантирует валидный тип и схему. type строго один из: " +
    Object.keys(CARD_TYPE_DIR).join(", ") +
    ". Поля вне схемы недопустимы. Summary (день/неделя/…) НЕ создавай — их пишет ночной rollup.",
  inputSchema: z.object({
    operation: z
      .enum(["ADD", "UPDATE", "SUPERSEDE", "NOOP"])
      .optional()
      .describe(
        "ADD создаёт новую карточку; UPDATE добавляет непротиворечивый факт в ## Log; " +
          "SUPERSEDE заменяет текущую истину; NOOP ничего не пишет.",
      ),
    type: z
      .preprocess(normalizeType, z.enum(CARD_TYPES))
      .describe(
        "Тип карточки (строго из списка; алиасы вроде person/company → contact применяются автоматически)",
      ),
    title: z
      .string()
      .min(1)
      .describe("Имя/заголовок сущности (пойдёт в имя файла и заголовок)"),
    description: z
      .string()
      .min(1)
      .max(
        DESC_CAP,
        `description слишком длинное: максимум ${DESC_CAP} символов; сократи его и повтори вызов`,
      )
      .describe("Краткая выжимка что/зачем (1–2 фразы, для поиска)"),
    tags: z
      .array(z.string())
      .min(1)
      .max(6)
      .describe("2–5 тегов, lowercase-kebab"),
    status: z
      .string()
      .optional()
      .describe("Статус жизненного цикла (валидируется по типу)"),
    domain: z
      .string()
      .optional()
      .describe("Домен (work/personal/…), опционально"),
    related: z
      .array(z.string())
      .optional()
      .describe("Вики-цели связей [[...]] (vault-пути или слаги), опционально"),
    body: z
      .string()
      .min(1)
      .describe("Тело карточки в markdown (контекст, факты)"),
    history_entry: z
      .string()
      .min(1)
      .refine(
        (value) => !/[\r\n]/.test(value),
        "history_entry должен быть одной строкой",
      )
      .optional()
      .describe(
        "Для SUPERSEDE: датированная строка о прежней истине, переносимая в ## History",
      ),
    confidence: z
      .enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"])
      .optional()
      .describe(
        "EXTRACTED — прямо сказано; INFERRED — выведено; по умолчанию EXTRACTED",
      ),
    replace_body: z
      .boolean()
      .optional()
      .describe(
        "ТОЛЬКО для SUPERSEDE: заменить body целиком (сам перенеси старое значение в ## History). " +
          "Без флага body дописывается, противоречащие факты так не исправить.",
      ),
  }),
  // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the established Promise-returning Eve tool contract.
  async execute({
    operation,
    type,
    title,
    description,
    tags,
    status,
    domain,
    related,
    body,
    history_entry,
    confidence,
    replace_body,
  }) {
    // Валидация статуса против схемы типа (жёстко — иначе модель придумает статус).
    const allowed = SCHEMA.status[type] || ["active"];
    const st = status && allowed.includes(status) ? status : allowed[0];
    if (status && !allowed.includes(status)) {
      return {
        ok: false,
        error: `Недопустимый status "${status}" для type "${type}". Разрешены: ${allowed.join(", ")}.`,
      };
    }

    const dir = join(VAULT(), "cards", CARD_TYPE_DIR[type]);
    // Идентичность: точный слаг → иначе карточка того же типа с таким же H1/name/aliases
    // (легаси-файлы с латинским слагом и кириллическим заголовком).
    const id = resolveCard(dir, title);
    if (id.candidates && id.candidates.length > 1) {
      const list = id.candidates.map((f) =>
        relative(VAULT(), f).split(sep).join("/"),
      );
      return {
        ok: false,
        error:
          `Неоднозначная карточка для "${title}": подходят ${list.length} файлов. ` +
          "Уточни заголовок или обнови нужный файл явно — ничего не записано.",
        candidates: list,
      };
    }
    const file = id.file;
    const rel = relative(VAULT(), file).split(sep).join("/");

    if (operation === "NOOP") {
      if (replace_body || history_entry) {
        return {
          ok: false,
          error: "NOOP не принимает replace_body или history_entry.",
        };
      }
      if (!existsSync(file)) {
        return {
          ok: false,
          error: `NOOP требует существующую карточку ${rel}.`,
        };
      }
      return {
        ok: true,
        file: rel,
        type,
        status: st,
        action: "noop",
        matchedBy: id.matchedBy,
      };
    }
    if (replace_body && operation && operation !== "SUPERSEDE") {
      return {
        ok: false,
        error: "replace_body допустим только для SUPERSEDE.",
      };
    }
    if (operation && operation !== "SUPERSEDE") {
      history_entry = undefined;
    }
    if (operation === "SUPERSEDE" && !history_entry) {
      return {
        ok: false,
        error: "SUPERSEDE требует history_entry с прежней истиной.",
      };
    }

    mkdirSync(dir, { recursive: true });

    // Сбои лока/записи — структурированная ошибка, а не исключение: модель должна
    // увидеть внятное «занято/не записалось» и решить, что делать, а не уронить ход.
    let release: (() => void) | null = null;
    try {
      release = acquireLock(file);
      const existing = existsSync(file)
        ? readFileSync(file, "utf8")
        : undefined;
      const effectiveOperation =
        operation ?? (replace_body ? "SUPERSEDE" : existing ? "UPDATE" : "ADD");
      if (effectiveOperation !== "SUPERSEDE") {
        history_entry = undefined;
      }
      if (effectiveOperation === "ADD" && existing !== undefined) {
        return {
          ok: false,
          error: `ADD отказан: карточка ${rel} уже существует.`,
        };
      }
      if (
        (effectiveOperation === "UPDATE" ||
          effectiveOperation === "SUPERSEDE") &&
        existing === undefined
      ) {
        return {
          ok: false,
          error: `${effectiveOperation} требует существующую карточку ${rel}.`,
        };
      }
      const legacyHistoryInBody = hasH2Section(body, "History");
      if (
        effectiveOperation === "SUPERSEDE" &&
        !history_entry &&
        !legacyHistoryInBody
      ) {
        return {
          ok: false,
          error:
            "SUPERSEDE требует history_entry; legacy replace_body должен содержать ## History.",
        };
      }
      const { content, action } = mergeCard({
        existing,
        title,
        fields: {
          type,
          description,
          tags: tags.map((t) => t.toLowerCase().replace(/\s+/g, "-")),
          status: st,
          confidence: confidence || "EXTRACTED",
          ...(domain ? { domain } : {}),
        },
        initialFields: { created: today(), source: `daily/${today()}.md` },
        body,
        related,
        date: today(),
        replaceBody: replace_body === true,
        operation: effectiveOperation,
        historyEntry: history_entry,
      });
      if (action !== "noop") atomicWrite(file, content);
      return {
        ok: true,
        file: rel,
        type,
        status: st,
        action,
        matchedBy: id.matchedBy,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Не удалось записать карточку ${rel}: ${detail}`,
      };
    } finally {
      release?.();
    }
  },
});
