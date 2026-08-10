// Хранилище карточек: поиск существующего файла по идентичности, слияние (merge)
// нового содержимого со старым, лок + атомарная запись.
//
// Инвариант: write_card сохраняет неизвестные поля frontmatter и created. UPDATE
// дополняет один ## Log, SUPERSEDE заменяет Compiled Truth и переносит прежний факт
// в ## History, а NOOP не пишет файл.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  hasUnclosedFence,
  outsideFences,
  scanFences,
} from "../../scripts/lib/card-text.ts";
import {
  parseFrontmatter,
  writeFrontmatter,
  type FmFields,
} from "./frontmatter.js";

export { outsideFences } from "../../scripts/lib/card-text.ts";

// ─── identity ──────────────────────────────────────────────────────────────

/** Слаг файла: кириллица сохраняется (vault хранит её нормально), пунктуация → дефис. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "card"
  );
}

/** Нормализация имени: без пунктуации, lowercase; скобки сохраняют содержимое. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Имя без уточнения в скобках — для матча «голое имя ↔ квалифицированная карточка». */
export function baseName(s: string): string {
  return normalizeName(s.replace(/\([^)]*\)/g, " "));
}

const hasQualifier = (s: string) => /\(/.test(s);

export function extractH1(body: string): string | null {
  const lines = body.split("\n");
  const outside = outsideFences(lines);
  const line = lines.find(
    (candidate, index) => outside[index] && /^ {0,3}#\s+/.test(candidate),
  );
  const m = line ? /^ {0,3}#\s+(.+)$/.exec(line) : null;
  return m ? m[1].trim() : null;
}

function fmNames(fields: FmFields | null): string[] {
  if (!fields) return [];
  const out: string[] = [];
  for (const key of ["name", "title", "aka", "aliases"]) {
    const v = fields[key];
    if (!v) continue;
    if (Array.isArray(v)) out.push(...v);
    else
      out.push(
        ...String(v)
          .split(",")
          .map((x) => x.trim()),
      );
  }
  return out.filter(Boolean);
}

export interface Identity {
  /** Абсолютный/относительный путь файла карточки (может ещё не существовать). */
  file: string;
  /** Файл найден по H1/name/aliases, а не по точному слагу (легаси-слаг). */
  matchedBy: "slug" | "title" | "new";
  /** Несколько кандидатов — писать нельзя, нужен выбор человека/модели. */
  candidates?: string[];
}

/**
 * Идентичность карточки: сначала точный слаг, иначе — поиск среди карточек ТОГО ЖЕ типа
 * по H1-заголовку и полям name/title/aka/aliases. Так карточка с латинским легаси-слагом
 * (yasmin.md) и кириллическим H1 («Ясмин …») находится, а не дублируется.
 * Несколько кандидатов → candidates, вызывающий обязан отказаться от записи.
 */
export function resolveCard(dir: string, title: string): Identity {
  const slug = slugify(title);
  const exact = join(dir, `${slug}.md`);
  if (existsSync(exact)) return { file: exact, matchedBy: "slug" };

  // Правило квалификаторов: «Ясмин» (без скобок) находит «Ясмин (AI Content Creator)»,
  // но «Alex (UK)» НЕ сливается в «Alex (US)» — квалифицированный запрос матчится только
  // при полном совпадении (со скобками), иначе это другая сущность и нужен новый файл.
  const wanted = normalizeName(title);
  const wantedBase = baseName(title);
  const bareQuery = !hasQualifier(title);
  const hits: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    const full = join(dir, name);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const { fields, body } = parseFrontmatter(text);
    const h1 = extractH1(body);
    const cands = [h1, ...fmNames(fields), name.replace(/\.md$/, "")].filter(
      Boolean,
    ) as string[];
    const matched = cands.some(
      (c) =>
        normalizeName(c) === wanted ||
        (bareQuery && baseName(c) === wantedBase),
    );
    if (matched) hits.push(full);
  }

  if (hits.length === 1) return { file: hits[0], matchedBy: "title" };
  if (hits.length > 1)
    return { file: exact, matchedBy: "new", candidates: hits };
  return { file: exact, matchedBy: "new" };
}

// ─── merge ─────────────────────────────────────────────────────────────────

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Уже ли новый текст (по сути) есть в старом body — чтобы не дописывать дубль. */
export function bodyContains(existingBody: string, incoming: string): boolean {
  const a = norm(existingBody);
  const b = norm(incoming);
  return b.length === 0 || a.includes(b);
}

interface H2Section {
  start: number;
  end: number;
}

interface NamedH2Section extends H2Section {
  heading: string;
  key: string;
}

export function h2Sections(lines: string[], heading: string): H2Section[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wanted = new RegExp(`^ {0,3}##\\s+${escaped}\\s*$`, "i");
  const outside = outsideFences(lines);
  const starts = lines.flatMap((line, index) =>
    outside[index] && wanted.test(line) ? [index] : [],
  );
  return starts.map((start) => {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
      if (outside[index] && /^ {0,3}#{1,2}\s+/.test(lines[index])) {
        end = index;
        break;
      }
    }
    return { start, end };
  });
}

function hasH2Section(body: string, heading: string): boolean {
  return h2Sections(body.split("\n"), heading).length > 0;
}

function hasOutsideHeading(body: string, pattern: RegExp): boolean {
  const lines = body.split("\n");
  const outside = outsideFences(lines);
  return lines.some((line, index) => outside[index] && pattern.test(line));
}

function namedH2Sections(lines: string[]): NamedH2Section[] {
  const outside = outsideFences(lines);
  const starts = lines.flatMap((line, index) => {
    if (!outside[index]) return [];
    const match = /^ {0,3}##\s+(.+?)\s*$/.exec(line);
    return match
      ? [{ start: index, heading: match[1].trim(), key: norm(match[1]) }]
      : [];
  });
  return starts.map(({ start, heading, key }) => {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
      if (outside[index] && /^ {0,3}#{1,2}\s+/.test(lines[index])) {
        end = index;
        break;
      }
    }
    return { start, end, heading, key };
  });
}

function normalizeRelatedTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .split("|", 1)[0]
    .split("#", 1)[0]
    .trim()
    .toLowerCase();
}

function replaceH2Sections(
  body: string,
  heading: string,
  content: string[],
): string {
  const lines = body.split("\n");
  const sections = h2Sections(lines, heading);
  // Heading, blank line, entries - the shape the rest of the card already uses, so a
  // rewritten section never ends up glued to the next heading.
  const canonical = [`## ${heading}`, "", ...content];
  if (!sections.length) {
    return `${body.replace(/\s+$/, "")}\n\n${canonical.join("\n")}\n`;
  }

  const first = sections[0].start;
  const byStart = new Map(
    sections.map((section) => [section.start, section.end]),
  );
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const end = byStart.get(index);
    if (end !== undefined) {
      if (index === first) output.push(...canonical, "");
      index = end;
      continue;
    }
    output.push(lines[index]);
    index++;
  }
  return output.join("\n").replace(/\s+$/, "") + "\n";
}

/** Keep exactly one Related section and deduplicate targets ignoring alias/anchor. */
export function mergeRelated(body: string, related: string[]): string {
  const lines = body.split("\n");
  const sections = h2Sections(lines, "Related");
  const seen = new Set<string>();
  const links: string[] = [];
  const prose: string[] = [];

  for (const section of sections) {
    for (const line of lines.slice(section.start + 1, section.end)) {
      if (!line.trim()) continue;
      const matches = [...line.matchAll(/\[\[([^\]]+)\]\]/g)];
      const remainder = line
        .replace(/\[\[[^\]]+\]\]/g, "")
        .replace(/[-*·,;:\s]/g, "");
      if (matches.length && !remainder) {
        for (const match of matches) {
          const target = normalizeRelatedTarget(match[1]);
          if (!target || seen.has(target)) continue;
          seen.add(target);
          links.push(match[1].trim());
        }
      } else {
        prose.push(line);
        for (const match of matches) seen.add(normalizeRelatedTarget(match[1]));
      }
    }
  }

  for (const raw of related) {
    const display = raw.trim().replace(/^\[\[|\]\]$/g, "");
    const target = normalizeRelatedTarget(display);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    links.push(display);
  }

  if (!sections.length && !prose.length && !links.length) return body;
  const content = [...prose, ...links.map((link) => `- [[${link}]]`)];
  return replaceH2Sections(body, "Related", content);
}

function sectionContent(body: string, heading: string): string[] {
  const lines = body.split("\n");
  return h2Sections(lines, heading).flatMap((section) =>
    lines.slice(section.start + 1, section.end).filter((line) => line.trim()),
  );
}

function removeH2Sections(body: string, heading: string): string {
  const lines = body.split("\n");
  const sections = h2Sections(lines, heading);
  if (!sections.length) return body;
  const byStart = new Map(
    sections.map((section) => [section.start, section.end]),
  );
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const end = byStart.get(index);
    if (end !== undefined) {
      index = end;
      continue;
    }
    output.push(lines[index]);
    index++;
  }
  return output.join("\n").replace(/\s+$/, "") + "\n";
}

/** История хранится как `- YYYY-MM-DD: факт`. Дата, которую назвала модель, считается
 * своей независимо от буллета — иначе в append-only архив навсегда уезжает вторая дата
 * поверх первой. Строку без даты датируем днём записи. */
function canonicalHistoryEntry(historyEntry: string, date: string): string {
  const entry = historyEntry.trim().replace(/^[-*]\s+/, "");
  return /^\d{4}-\d{2}-\d{2}:/.test(entry)
    ? `- ${entry}`
    : `- ${date}: ${entry}`;
}

function lastHistoryEntry(body: string): string | undefined {
  const lines = body.split("\n");
  const sections = h2Sections(lines, "History");
  if (sections.length !== 1) return undefined;
  const content = lines
    .slice(sections[0].start + 1, sections[0].end)
    .filter((line) => line.trim());
  return content.at(-1)?.trim();
}

/** Текст факта без буллета и без ведущей даты записи - общая форма для сверки
 * с хвостом Истории. Дата в хвосте необязательна: строки, оставленные легаси-картой
 * или механическим слиянием autograph, приходят без неё. */
function historyFact(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\d{4}-\d{2}-\d{2}:\s*/, "");
}

/** То же вытеснение, что уже стоит в хвосте Истории. Датированную строку сверяем
 * целиком: две даты у одного факта - два разных вытеснения. Недатированную сверяем
 * по тексту факта, иначе её повтор на следующие сутки уедет в архив второй строкой
 * под новой датой. Дальше хвоста дедуп не идёт - это уничтожало бы свидетельства. */
function repeatsHistoryTail(
  historyEntry: string,
  dated: string,
  tail: string | undefined,
): boolean {
  if (tail === undefined) return false;
  if (tail.trim() === dated.trim()) return true;
  const fact = historyEntry.trim().replace(/^[-*]\s+/, "");
  if (/^\d{4}-\d{2}-\d{2}:/.test(fact)) return false;
  return historyFact(tail) === fact;
}

/** Многострочное тело ложится под буллет Log со сдвигом на два пробела. Судить его надо
 * ровно в этом виде: сдвиг меняет разметку, а карточка хранит результат сдвига. */
function logEntryLines(incoming: string, date: string): string[] {
  const incomingLines = incoming.trim().split("\n");
  return incomingLines.length === 1
    ? [`- ${date}: ${incomingLines[0]}`]
    : [`- ${date}:`, ...incomingLines.map((line) => `  ${line}`)];
}

function appendLog(body: string, incoming: string, date: string): string {
  const oldEntries = sectionContent(body, "Log");
  const withoutLogs = removeH2Sections(body, "Log");
  return replaceH2Sections(withoutLogs, "Log", [
    ...oldEntries,
    logEntryLines(incoming, date).join("\n"),
  ]);
}

function collapseLogSections(body: string): string {
  const lines = body.split("\n");
  if (h2Sections(lines, "Log").length <= 1) return body;
  return replaceH2Sections(body, "Log", sectionContent(body, "Log"));
}

function replaceCompiledTruth(
  oldBody: string,
  replacement: string,
  historyEntry: string | undefined,
  date: string,
): string {
  const structural = new Set(["log", "history", "related"]);
  const oldLines = oldBody.split("\n");
  const replacementLines = replacement.split("\n");
  const oldSections = namedH2Sections(oldLines);
  const replacementSections = namedH2Sections(replacementLines);
  const replacementKeys = new Set(
    replacementSections.map((section) => section.key),
  );

  // The replacement owns Compiled Truth. Structural archives remain append-only,
  // and an old custom H2 survives unless the replacement explicitly names it.
  const replacementStructuralStarts = new Map(
    replacementSections
      .filter((section) => structural.has(section.key))
      .map((section) => [section.start, section.end]),
  );
  const truthLines: string[] = [];
  for (let index = 0; index < replacementLines.length;) {
    const end = replacementStructuralStarts.get(index);
    if (end !== undefined) {
      index = end;
      continue;
    }
    truthLines.push(replacementLines[index]);
    index++;
  }

  const blocks = oldSections
    .filter(
      (section) =>
        structural.has(section.key) || !replacementKeys.has(section.key),
    )
    .map((section) => ({
      key: section.key,
      heading: section.heading,
      lines: oldLines.slice(section.start, section.end),
    }));

  const additions = new Map<string, string[]>();
  for (const section of replacementSections.filter((candidate) =>
    structural.has(candidate.key),
  )) {
    let content = replacementLines.slice(section.start + 1, section.end);
    while (content.length && !content.at(-1)?.trim()) content.pop();
    if (section.key === "history") {
      const oldHistory = oldSections.filter(
        (candidate) => candidate.key === "history",
      );
      const newHistory = replacementSections.filter(
        (candidate) => candidate.key === "history",
      );
      if (oldHistory.length > 1 || newHistory.length > 1) {
        throw new Error(
          "SUPERSEDE requires exactly one unambiguous ## History section",
        );
      }
      // История сравнивается по строкам-фактам: пустая строка между буллетами -
      // форматирование, а не свидетельство, и не должна ни ломать сверку префикса,
      // ни копиться в архиве.
      const entries = content.filter((line) => line.trim());
      if (!entries.length) {
        throw new Error(
          "SUPERSEDE replacement ## History must contain the displaced fact",
        );
      }
      content = entries;
      if (oldHistory.length === 1) {
        const oldEntries = oldLines
          .slice(oldHistory[0].start + 1, oldHistory[0].end)
          .filter((line) => line.trim());
        const prefixMatches = oldEntries.every(
          (line, index) => entries[index]?.trim() === line.trim(),
        );
        if (!prefixMatches) {
          throw new Error(
            "SUPERSEDE replacement ## History must preserve existing History as an exact prefix",
          );
        }
        content = entries.slice(oldEntries.length);
        if (!content.length && !historyEntry?.trim()) {
          throw new Error(
            "SUPERSEDE replacement ## History must append the displaced fact",
          );
        }
      }
    }
    if (content.some((line) => line.length)) {
      additions.set(section.key, [
        ...(additions.get(section.key) ?? []),
        ...content,
      ]);
    }
  }
  if (historyEntry?.trim()) {
    const dated = canonicalHistoryEntry(historyEntry, date);
    const pending = additions.get("history") ?? [];
    // Один вытесненный факт - одна строка. Модель, дописавшая ## History в body
    // (секция принадлежит write_card), и реплей уже выполненного вызова подают
    // тот же факт вторым путём; хвост Истории решает, новый он или нет.
    const tail = pending.at(-1)?.trim() ?? lastHistoryEntry(oldBody);
    if (!repeatsHistoryTail(historyEntry, dated, tail)) {
      additions.set("history", [...pending, dated]);
    }
  }

  for (const [key, lines] of additions) {
    let block = [...blocks]
      .reverse()
      .find((candidate) => candidate.key === key);
    if (!block) {
      const heading =
        key === "history" ? "History" : key === "log" ? "Log" : "Related";
      block = { key, heading, lines: [`## ${heading}`] };
      blocks.push(block);
    }
    // Blank line after the heading, none between entries: otherwise every SUPERSEDE
    // adds one more blank to the archive and the list renders loose.
    while (block.lines.length > 1 && !block.lines.at(-1)?.trim())
      block.lines.pop();
    if (/^ {0,3}#{1,6}\s/.test(block.lines.at(-1) ?? "")) block.lines.push("");
    block.lines.push(...lines);
  }

  const output = [...truthLines];
  while (output.length && !output.at(-1)?.trim()) output.pop();
  for (const block of blocks) {
    if (output.length && output.at(-1)?.trim()) output.push("");
    output.push(...block.lines);
  }
  return output.join("\n").replace(/\s+$/, "") + "\n";
}

export type CardOperation = "ADD" | "UPDATE" | "SUPERSEDE" | "NOOP";
export const HISTORY_ENTRY_CAP = 500;

interface OperationInput {
  /** Операция, названная вызывающим; undefined — легаси-вызов без operation. */
  operation?: CardOperation;
  /** SUPERSEDE: заменить body целиком (frontmatter всё равно сливается). */
  replaceBody?: boolean;
  /** Содержимое существующего файла (undefined — карточки ещё нет). */
  existing?: string;
}

/**
 * Единственный источник вывода операции: явная operation, иначе легаси-автодетект.
 * Вызывающий обязан передавать в mergeCard сырую operation — по её отсутствию
 * отличается легаси-путь replace_body, где ## History приходит внутри body.
 */
export function resolveOperation(input: OperationInput): CardOperation {
  if (input.operation) return input.operation;
  if (input.replaceBody) return "SUPERSEDE";
  return input.existing === undefined ? "ADD" : "UPDATE";
}

/**
 * Легаси-путь, где вытесненная истина приходит секцией `## History` внутри body:
 * только вызов БЕЗ operation с replace_body. У явного SUPERSEDE его нет - там
 * вытесненный факт передаётся через historyEntry. Тул и стор обязаны решать это
 * одинаково, иначе один пускает вызов, а второй роняет его английским исключением.
 */
export function isLegacyHistoryReplace(
  operation: CardOperation | undefined,
  replaceBody: boolean | undefined,
  body: string,
): boolean {
  return (
    operation === undefined &&
    replaceBody === true &&
    hasH2Section(body.trim(), "History")
  );
}

export interface MergeInput extends OperationInput {
  title: string;
  fields: FmFields; // поля, которые тул реально знает и обновляет
  /** Поля только для новой карточки (created/source) — при merge не трогаются. */
  initialFields?: FmFields;
  body: string;
  related?: string[];
  /** Дата для маркера дописанного блока. */
  date: string;
  /** One dated fact moved out of Compiled Truth during SUPERSEDE. */
  historyEntry?: string;
}

export interface MergeResult {
  content: string;
  action: "created" | "updated" | "merged" | "replaced" | "noop";
  /** Model noise discarded because a new card has no displaced truth. */
  ignoredHistoryEntry?: true;
}

export function mergeCard(input: MergeInput): MergeResult {
  const {
    existing,
    title,
    fields,
    initialFields,
    body,
    related,
    date,
    replaceBody,
    historyEntry,
  } = input;
  const trimmedBody = body.trim();
  const operation = resolveOperation(input);

  if (h2Sections(trimmedBody.split("\n"), "Related").length) {
    throw new Error(
      "body must not contain ## Related; pass links through related",
    );
  }
  if (replaceBody && operation !== "SUPERSEDE") {
    throw new Error("replaceBody is valid only for SUPERSEDE");
  }
  if (
    historyEntry !== undefined &&
    operation !== "ADD" &&
    operation !== "SUPERSEDE"
  ) {
    throw new Error("historyEntry is valid only for SUPERSEDE");
  }
  if (
    operation === "SUPERSEDE" &&
    historyEntry !== undefined &&
    /[\r\n]/.test(historyEntry)
  ) {
    throw new Error("historyEntry must be a single line");
  }
  if (
    operation === "SUPERSEDE" &&
    historyEntry !== undefined &&
    historyEntry.trim().length > HISTORY_ENTRY_CAP
  ) {
    throw new Error(
      `historyEntry must not exceed ${HISTORY_ENTRY_CAP} characters`,
    );
  }
  // Незакрытый фенс делает кодом всё до конца тела, и гейт заголовков ниже перестаёт
  // видеть ## History/## Log за ним. Искать заголовки внутри открытого фенса нечем -
  // такое тело отклоняется целиком, включая легаси-путь replace_body: он единственный,
  // через который открытый фенс попадал в карточку и ломал её следующий SUPERSEDE.
  // NOOP тела не пишет вовсе, поэтому его фенс никого не касается.
  if (operation !== "NOOP" && hasUnclosedFence(trimmedBody)) {
    throw new Error(`${operation} body must close every code fence`);
  }
  // Секции карточки принадлежат write_card: H1 - заголовку, ## History/## Log -
  // append-only архивам. Тело, которое сочинила модель, несёт факт и только факт, иначе
  // выдуманный архив въезжает в карточку соседним полем и вычистить его уже нечем.
  if (
    (operation === "ADD" || operation === "UPDATE") &&
    hasOutsideHeading(trimmedBody, /^ {0,3}#{1,2}\s+/)
  ) {
    throw new Error(`${operation} body must be a fact without H1/H2 headings`);
  }
  // Гейты выше судят сырое тело, а UPDATE кладёт его в карточку сдвинутым на два пробела
  // под буллет Log. Фенс с отступом 2-3 после сдвига уезжает на 4-5 и фенсом быть
  // перестаёт: его содержимое выходит наружу, и спрятанный внутри ## History становится
  // настоящим заголовком append-only архива. Поэтому запись судим в том виде, в каком
  // она ляжет в карточку.
  if (operation === "UPDATE") {
    const entry = logEntryLines(trimmedBody, date);
    const scanned = scanFences(entry);
    if (
      scanned.open ||
      entry.some(
        (line, index) =>
          scanned.outside[index] && /^ {0,3}#{1,2}\s+/.test(line),
      )
    ) {
      throw new Error(
        "UPDATE body must start every code fence at the line start; a Log entry indents the body by two spaces",
      );
    }
  }
  if (operation === "NOOP") {
    if (existing === undefined)
      throw new Error("NOOP requires an existing card");
    return { content: existing ?? "", action: "noop" };
  }
  if (operation === "ADD" && existing !== undefined) {
    throw new Error("ADD refuses to overwrite an existing card");
  }
  if (
    (operation === "UPDATE" || operation === "SUPERSEDE") &&
    existing === undefined
  ) {
    throw new Error(`${operation} requires an existing card`);
  }
  if (
    operation === "SUPERSEDE" &&
    !historyEntry?.trim() &&
    !isLegacyHistoryReplace(input.operation, replaceBody, trimmedBody)
  ) {
    throw new Error(
      "SUPERSEDE requires historyEntry or a legacy ## History section",
    );
  }
  // Тело SUPERSEDE переписывает Compiled Truth, поэтому свои H2 ему разрешены, а H1 и
  // структурные архивы - нет: иначе модель дописывает в append-only ## History строки с
  // произвольными датами, и вычистить их уже нечем. Легаси-путь (replace_body без
  // operation) не трогаем - там ## History и есть способ передать вытесненный факт.
  if (
    operation === "SUPERSEDE" &&
    input.operation !== undefined &&
    hasOutsideHeading(trimmedBody, /^ {0,3}(?:#\s+|##\s+(?:History|Log)\s*$)/i)
  ) {
    throw new Error(
      "SUPERSEDE body must be a fact without an H1 or a ## History/## Log heading",
    );
  }

  if (existing === undefined) {
    const all: FmFields = { ...fields, ...(initialFields || {}) };
    const fm = ["---", writeFrontmatter(all, []), "---", ""].join("\n");
    let out = `${fm}\n# ${title}\n\n${trimmedBody}\n`;
    if (related && related.length) out = mergeRelated(out, related);
    return {
      content: out,
      action: "created",
      ...(historyEntry !== undefined
        ? { ignoredHistoryEntry: true as const }
        : {}),
    };
  }

  const parsed = parseFrontmatter(existing);
  const oldBody = parsed.body;
  // Тот же принцип со стороны диска: открытый фенс в лежащей карточке уводит её
  // ## History в код, границ секций нет - замена Compiled Truth молча снесла бы весь
  // append-only архив. Отказ; фенс в карточке чинит человек.
  if (operation === "SUPERSEDE" && hasUnclosedFence(oldBody)) {
    throw new Error(
      "existing card body leaves a code fence open; close it before SUPERSEDE",
    );
  }
  if (
    operation === "UPDATE" &&
    hasOutsideHeading(
      oldBody,
      /^ {0,3}##\s+(?:Обновление|Update)\s+\d{4}-\d{2}-\d{2}\s*$/i,
    )
  ) {
    throw new Error(
      "existing card has legacy dated update headings; run semantic cleanup before UPDATE",
    );
  }
  // Обновляем ТОЛЬКО известные ключи; created/source и любые неизвестные поля
  // (tier, relevance, last_accessed, phone, telegram, priority…) остаются как были.
  const updates: FmFields = { ...fields };
  delete updates.created;
  if (parsed.fields?.source) delete updates.source;
  if (parsed.fields) {
    const oldTags = parsed.fields.tags;
    const newTags = updates.tags;
    if (Array.isArray(newTags)) {
      const prev = Array.isArray(oldTags)
        ? oldTags
        : String(oldTags || "")
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
      updates.tags = [...new Set([...prev, ...newTags])];
    }
  }
  updates.updated = date;

  let newBody = operation === "UPDATE" ? collapseLogSections(oldBody) : oldBody;
  let appended = false;
  // A confirmed-cancel rollup retry can replay the exact completed tool call. Only that
  // fixed point is suppressed: the same canonical entry already ends History, so the
  // truth behind it is displaced already. Global History dedup would destroy evidence.
  const replayed =
    operation === "SUPERSEDE" &&
    !!historyEntry?.trim() &&
    repeatsHistoryTail(
      historyEntry,
      canonicalHistoryEntry(historyEntry, date),
      lastHistoryEntry(oldBody),
    );
  if (operation === "SUPERSEDE") {
    newBody = `\n${replaceCompiledTruth(oldBody, trimmedBody, historyEntry, date).trim()}\n`;
  } else if (!bodyContains(oldBody, trimmedBody)) {
    newBody = appendLog(newBody, trimmedBody, date);
    appended = true;
  }
  if (!extractH1(newBody))
    newBody = `# ${title}\n\n${newBody.replace(/^\s+/, "")}`;
  const beforeRelated = newBody;
  newBody = mergeRelated(newBody, related ?? []);
  if (beforeRelated !== newBody) appended = true;

  const render = (stamp: string) =>
    `---\n${writeFrontmatter(
      { ...updates, updated: stamp },
      parsed.fields ? parsed.lines : [],
    )}\n---\n${newBody.replace(/\s*$/, "")}\n`;
  const content = render(date);
  // Реплей, перешагнувший полночь, отличается от лежащей карточки только сегодняшним
  // `updated:`. Записать файл ради одной этой строки - выдать за изменение то, что
  // изменением не является, поэтому дату исключаем из сверки.
  const previousStamp = parsed.fields?.updated;
  if (
    replayed &&
    (content === existing ||
      (typeof previousStamp === "string" && render(previousStamp) === existing))
  )
    return { content: existing, action: "noop" };
  return {
    content,
    action:
      operation === "SUPERSEDE" ? "replaced" : appended ? "merged" : "updated",
  };
}

// ─── lock + атомарная запись ───────────────────────────────────────────────

const LOCK_STALE_MS = 15_000;

/** Lock-файл (O_EXCL) с токеном владения: release снимает лок, только пока на диске
 * наш токен — вытесненный по staleness держатель не удалит лок преемника. */
export function acquireLock(file: string, timeoutMs = 5000): () => void {
  const lock = `${file}.lock`;
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Дедлайн проверяется на КАЖДОЙ итерации, включая путь «лок исчез между попыткой
    // и stat» — иначе мигающий лок зациклил бы захват навсегда.
    if (Date.now() > deadline)
      throw new Error(`Карточка занята другим процессом: ${lock}`);
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, token);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lock, "utf8") !== token) return; // лок уже не наш
          rmSync(lock, { force: true });
        } catch {
          /* лок уже снят */
        }
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      // Протухший лок от упавшего процесса не должен блокировать навсегда.
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch (statErr) {
        // Лок исчез между попыткой и stat — новая итерация; прочие сбои stat — наружу.
        if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Запись через временный файл + rename: читатель никогда не видит половину карточки. */
export function atomicWrite(file: string, content: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* нечего чистить */
    }
    throw err;
  }
}
