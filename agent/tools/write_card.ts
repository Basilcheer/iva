import { defineTool } from "eve/tools";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { resolveVaultDir } from "@iva/vault-dir";
import {
  ALIASES_MAX,
  aliasList,
  disappearedLines,
  extractH1,
  listCardFiles,
  logFactKey,
  mergeRelated,
  normalizeName,
  replaceH2Sections,
  sanitizeField,
  sectionRows,
  slugify,
  truthOf,
  TYPE_DIR,
  withCardLock,
  withTruth,
} from "../lib/card-store.ts";
import { hasUnclosedFence } from "../lib/card-text.ts";
import {
  parseFrontmatterOrSkip,
  writeFrontmatter,
  type FmFields,
  type ParsedFrontmatter,
} from "../lib/frontmatter.ts";
import { writeFileAtomicSync } from "../lib/fs-atomic.ts";
import { commitVaultWrite } from "../lib/vault-commit.ts";
import { localStamp } from "../lib/vault-daily.ts";
import { vaultDirErrorText } from "../lib/vault-error.ts";

const TYPES = Object.keys(TYPE_DIR) as [string, ...string[]];
const oneLine = z
  .string()
  .min(1)
  .refine(
    (value) => !/[\r\n]/u.test(value),
    "значение должно быть одной строкой",
  );

const factInput = z.object({
  operation: z.literal("fact"),
  type: z.enum(TYPES),
  title: oneLine,
  text: oneLine,
  description: oneLine.max(500).optional(),
  tags: z.array(oneLine).max(6).default([]),
  aliases: z.array(oneLine.max(80)).max(ALIASES_MAX).default([]),
  source: oneLine.optional(),
});
const truthInput = z.object({
  operation: z.literal("truth"),
  type: z.enum(TYPES),
  title: oneLine,
  text: z.string(),
  reason: oneLine,
  source: oneLine.optional(),
});
const mergeInput = z.object({
  operation: z.literal("merge"),
  target: oneLine,
  duplicate: oneLine,
  confirmed_by_owner: z.literal(true),
});

// На провод уходит одна плоская схема: объединение схем в корне провайдеры не принимают
// (Anthropic требует input_schema.type), а без инструмента падает весь ход. Что нужно каждой
// операции, модель читает в описаниях полей; строгую форму операции проверяет execute и
// отвечает текстом, который модель сама исправит.
const wireInput = z.object({
  operation: z
    .enum(["fact", "truth", "merge"])
    .describe(
      "fact: type, title, text (одна строка), по желанию description, tags, aliases, source. " +
        "truth: type, title, text (новый Compiled Truth), reason, по желанию source. " +
        "merge: target, duplicate, confirmed_by_owner=true.",
    ),
  type: z.enum(TYPES).optional().describe("fact, truth: тип Card"),
  title: z.string().optional().describe("fact, truth: имя Card"),
  text: z
    .string()
    .optional()
    .describe("fact: факт одной строкой; truth: новый Compiled Truth"),
  description: z.string().optional().describe("fact: выжимка, до 500 символов"),
  tags: z.array(z.string()).optional().describe("fact: до 6 тегов"),
  aliases: z.array(z.string()).optional().describe("fact: другие написания"),
  source: z.string().optional().describe("fact, truth: откуда факт"),
  reason: z.string().optional().describe("truth: почему меняется истина"),
  target: z.string().optional().describe("merge: Card, которая остаётся"),
  duplicate: z.string().optional().describe("merge: дубль, который вливается"),
  confirmed_by_owner: z
    .boolean()
    .optional()
    .describe("merge: true только по явной просьбе владельца"),
});

const operationSchemas = z.discriminatedUnion("operation", [
  factInput,
  truthInput,
  mergeInput,
]);

function operationInput(
  raw: z.infer<typeof wireInput>,
): z.infer<typeof operationSchemas> | { error: string } {
  const parsed = operationSchemas.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
  return { error: `write_card ${raw.operation}: ${issues}` };
}

interface CardRecord {
  readonly file: string;
  readonly path: string;
  readonly title: string;
  readonly aliases: string[];
  readonly parsed: ParsedFrontmatter;
}

function cardPath(vault: string, file: string): string {
  return relative(vault, file).split(sep).join("/").replace(/\.md$/u, "");
}

function readCards(vault: string): CardRecord[] {
  return listCardFiles(vault).flatMap((file) => {
    const parsed = parseFrontmatterOrSkip(readFileSync(file, "utf8"), file);
    if (!parsed) return [];
    const title = extractH1(parsed.body) ?? basename(file, ".md");
    const aliases = aliasList(parsed.fields?.aliases);
    return [{ file, path: cardPath(vault, file), title, aliases, parsed }];
  });
}

function candidates(cards: readonly CardRecord[], value: string): CardRecord[] {
  const direct = value.replace(/^vault\//u, "").replace(/\.md$/u, "");
  const byPath = cards.filter((card) => card.path === direct);
  if (byPath.length) return byPath;
  const key = normalizeName(value);
  return cards.filter((card) =>
    [card.title, basename(card.file, ".md"), ...card.aliases]
      .map(normalizeName)
      .includes(key),
  );
}

function render(parsed: ParsedFrontmatter, fields: FmFields, body: string) {
  return `---\n${writeFrontmatter(fields, parsed.lines)}\n---\n${body.trim()}\n`;
}

/** Незакрытый блок кода: заголовок внутри кода нельзя принять за границу раздела —
 * fact, truth и merge отказывают до записи. */
function fenced(...cards: CardRecord[]) {
  const card = cards.find((item) => hasUnclosedFence(item.parsed.body));
  return card
    ? { ok: false, error: `Card ${card.path}: незакрытый блок кода` }
    : null;
}

// Правка записана — ход не падает; отказ коммита шов сам пишет в журнал (vault-commit).
async function save(vault: string, files: string[], message: string) {
  await commitVaultWrite(message, files, vault);
}

type FactInput = z.infer<typeof factInput>;

function newCard(vault: string, input: FactInput, date: string): CardRecord {
  const title = sanitizeField(input.title, 160);
  const file = join(
    vault,
    "cards",
    TYPE_DIR[input.type],
    `${slugify(title)}.md`,
  );
  mkdirSync(dirname(file), { recursive: true });
  const fields: FmFields = {
    type: input.type,
    description: sanitizeField(input.description ?? input.text),
    tags: input.tags.map((tag) => sanitizeField(tag, 80)),
    aliases: input.aliases.map((alias) => sanitizeField(alias, 80)),
    status: "active",
    created: date,
    source: input.source ?? `daily/${date}.md`,
  };
  const body = `# ${title}\n\n## Log\n\n## Related\n\n## History\n`;
  const parsed = { fields, body, lines: [] };
  return { file, path: cardPath(vault, file), title, aliases: [], parsed };
}

async function writeFact(input: FactInput) {
  const vault = resolveVaultDir(process.cwd());
  const date = localStamp().date;
  const found = candidates(readCards(vault), input.title);
  if (found.length > 1)
    return {
      ok: false,
      error: `Неоднозначная Card: ${found.map((c) => c.path).join(", ")}`,
    };
  const card = found[0] ?? newCard(vault, input, date);
  // Файл на месте новой Card есть, но не читается: чужой текст не затирается.
  if (!found[0] && existsSync(card.file))
    return {
      ok: false,
      error: `Card ${card.path} есть, но не читается; поправь её`,
    };
  const rows = sectionRows(card.parsed.body, "Log");
  if (fenced(card)) return fenced(card);
  if (rows === null)
    return { ok: false, error: `Card ${card.path}: неоднозначный Log` };
  const row = `- ${date}: ${sanitizeField(input.text)} · ${input.source ?? `[[daily/${date}]]`}`;
  if (rows.some((existing) => logFactKey(existing) === logFactKey(row)))
    return { ok: true, action: "fact", file: card.path };
  const body = replaceH2Sections(card.parsed.body, "Log", [...rows, row]);
  writeFileAtomicSync(
    card.file,
    render(card.parsed, card.parsed.fields ?? {}, body),
  );
  await save(vault, [card.file], `card ${basename(card.file, ".md")}: fact`);
  return { ok: true, action: "fact", file: card.path };
}

async function writeTruth(input: z.infer<typeof truthInput>) {
  const vault = resolveVaultDir(process.cwd());
  const found = candidates(readCards(vault), input.title);
  if (found.length !== 1)
    return {
      ok: false,
      error: found.length
        ? "Card неоднозначна"
        : "Card не найдена; truth не создаёт Card",
    };
  const card = found[0];
  if (fenced(card)) return fenced(card);
  const history = sectionRows(card.parsed.body, "History");
  if (history === null)
    return { ok: false, error: `Card ${card.path}: неоднозначный History` };
  const next = input.text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => sanitizeField(line))
    .filter(Boolean)
    .join("\n");
  const date = localStamp().date;
  const source = input.source ?? `[[daily/${date}]]`;
  const moved = disappearedLines(truthOf(card.parsed.body), next).map(
    (line) => `- ${date}: ${line} (${sanitizeField(input.reason)} · ${source})`,
  );
  const body = replaceH2Sections(withTruth(card.parsed.body, next), "History", [
    ...history,
    ...moved,
  ]);
  const fields: FmFields = { ...(card.parsed.fields ?? {}), truth_date: date };
  delete fields.truth_pending;
  writeFileAtomicSync(card.file, render(card.parsed, fields, body));
  await save(vault, [card.file], `card ${basename(card.file, ".md")}: truth`);
  return { ok: true, action: "truth", file: card.path };
}

async function mergeCards(input: z.infer<typeof mergeInput>) {
  const vault = resolveVaultDir(process.cwd());
  const cards = readCards(vault);
  const [targets, duplicates] = [
    candidates(cards, input.target),
    candidates(cards, input.duplicate),
  ];
  if (targets.length !== 1 || duplicates.length !== 1)
    return {
      ok: false,
      error: "merge требует две однозначные существующие Card",
    };
  const [target, duplicate] = [targets[0], duplicates[0]];
  if (target.file === duplicate.file)
    return { ok: false, error: "Card нельзя склеить с самой собой" };
  if (fenced(target, duplicate)) return fenced(target, duplicate);
  let body = target.parsed.body;
  for (const heading of ["Log", "History", "Related"]) {
    const left = sectionRows(target.parsed.body, heading);
    const right = sectionRows(duplicate.parsed.body, heading);
    if (left === null || right === null)
      return { ok: false, error: `${heading} неоднозначный` };
    body = replaceH2Sections(body, heading, [...new Set([...left, ...right])]);
  }
  body = mergeRelated(body, [duplicate.path]);
  const aliases = [
    ...new Set(
      [...target.aliases, duplicate.title, ...duplicate.aliases].map((value) =>
        sanitizeField(value, 80),
      ),
    ),
  ].slice(0, ALIASES_MAX);
  writeFileAtomicSync(
    target.file,
    render(target.parsed, { ...(target.parsed.fields ?? {}), aliases }, body),
  );
  const duplicateFields = {
    ...(duplicate.parsed.fields ?? {}),
    status: "superseded",
    superseded_by: `[[${target.path}]]`,
  };
  writeFileAtomicSync(
    duplicate.file,
    render(
      duplicate.parsed,
      duplicateFields,
      `# ${duplicate.title}\n\nСклеено с [[${target.path}]].\n`,
    ),
  );
  await save(
    vault,
    [target.file, duplicate.file],
    `cards: merge ${basename(duplicate.file, ".md")} into ${basename(target.file, ".md")}`,
  );
  return {
    ok: true,
    action: "merge",
    file: target.path,
    duplicate: duplicate.path,
  };
}

export default defineTool({
  description:
    "Card памяти: fact дописывает факт (и может создать Card после поиска), truth меняет Compiled Truth с архивом, merge склеивает дубль только по явной просьбе владельца.",
  inputSchema: wireInput,
  async execute(raw) {
    const input = operationInput(raw);
    if ("error" in input) return { ok: false, error: input.error };
    try {
      // Одна правка Card за раз (и с ночью): параллельные ходы не сливаются в коммит.
      return await withCardLock(resolveVaultDir(process.cwd()), async () => {
        if (input.operation === "fact") return await writeFact(input);
        if (input.operation === "truth") return await writeTruth(input);
        return await mergeCards(input);
      });
    } catch (error) {
      const text = vaultDirErrorText(error);
      if (text !== null) return { ok: false, error: text };
      throw error;
    }
  },
});
