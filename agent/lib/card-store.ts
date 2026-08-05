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
import { parseFrontmatter, writeFrontmatter, type FmFields } from "./frontmatter.js";

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
  const line = lines.find((candidate, index) => outside[index] && /^ {0,3}#\s+/.test(candidate));
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
    else out.push(...String(v).split(",").map((x) => x.trim()));
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
  let names: string[] = [];
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
    const cands = [h1, ...fmNames(fields), name.replace(/\.md$/, "")].filter(Boolean) as string[];
    const matched = cands.some(
      (c) => normalizeName(c) === wanted || (bareQuery && baseName(c) === wantedBase),
    );
    if (matched) hits.push(full);
  }

  if (hits.length === 1) return { file: hits[0], matchedBy: "title" };
  if (hits.length > 1) return { file: exact, matchedBy: "new", candidates: hits };
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

function outsideFences(lines: string[]): boolean[] {
  const outside = Array(lines.length).fill(true) as boolean[];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      outside[index] = false;
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) continue;
    outside[index] = false;
    fence = { marker: open[1][0] as "`" | "~", length: open[1].length };
  }
  return outside;
}

function h2Sections(lines: string[], heading: string): H2Section[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wanted = new RegExp(`^ {0,3}##\\s+${escaped}\\s*$`, "i");
  const outside = outsideFences(lines);
  const starts = lines.flatMap((line, index) => (outside[index] && wanted.test(line) ? [index] : []));
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

function normalizeRelatedTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .split("|", 1)[0]
    .split("#", 1)[0]
    .trim()
    .toLowerCase();
}

function replaceH2Sections(body: string, heading: string, content: string[]): string {
  const lines = body.split("\n");
  const sections = h2Sections(lines, heading);
  const canonical = [`## ${heading}`, ...content];
  if (!sections.length) {
    return `${body.replace(/\s+$/, "")}\n\n${canonical.join("\n")}\n`;
  }

  const first = sections[0].start;
  const byStart = new Map(sections.map((section) => [section.start, section.end]));
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const end = byStart.get(index);
    if (end !== undefined) {
      if (index === first) output.push(...canonical);
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
  const byStart = new Map(sections.map((section) => [section.start, section.end]));
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

function appendLog(body: string, incoming: string, date: string): string {
  const oldEntries = sectionContent(body, "Log");
  const withoutLogs = removeH2Sections(body, "Log");
  const incomingLines = incoming.trim().split("\n");
  const entry = incomingLines.length === 1
    ? `- ${date}: ${incomingLines[0]}`
    : [`- ${date}:`, ...incomingLines.map((line) => `  ${line}`)].join("\n");
  return replaceH2Sections(withoutLogs, "Log", [...oldEntries, entry]);
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
  const history = [...sectionContent(oldBody, "History"), ...sectionContent(replacement, "History")];
  const log = [...sectionContent(oldBody, "Log"), ...sectionContent(replacement, "Log")];
  const related = [...sectionContent(oldBody, "Related"), ...sectionContent(replacement, "Related")];
  if (historyEntry?.trim()) {
    const entry = historyEntry.trim();
    history.push(/^[-*]\s+/.test(entry) ? entry : `- ${date}: ${entry}`);
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const line of history) {
    const key = norm(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  let truth = removeH2Sections(replacement, "History");
  truth = removeH2Sections(truth, "Log");
  truth = removeH2Sections(truth, "Related");
  if (log.length) truth = replaceH2Sections(truth, "Log", log);
  if (deduped.length) truth = replaceH2Sections(truth, "History", deduped);
  if (related.length) truth = replaceH2Sections(truth, "Related", related);
  return truth;
}

export type CardOperation = "ADD" | "UPDATE" | "SUPERSEDE" | "NOOP";

export interface MergeInput {
  /** Содержимое существующего файла (undefined — карточки ещё нет). */
  existing?: string;
  title: string;
  fields: FmFields; // поля, которые тул реально знает и обновляет
  /** Поля только для новой карточки (created/source) — при merge не трогаются. */
  initialFields?: FmFields;
  body: string;
  related?: string[];
  /** Дата для маркера дописанного блока. */
  date: string;
  /** SUPERSEDE: заменить body целиком (frontmatter всё равно сливается). */
  replaceBody?: boolean;
  /** Explicit operation; omitted callers retain legacy auto-detection. */
  operation?: CardOperation;
  /** One dated fact moved out of Compiled Truth during SUPERSEDE. */
  historyEntry?: string;
}

export interface MergeResult {
  content: string;
  action: "created" | "updated" | "merged" | "replaced" | "noop";
}

export function mergeCard(input: MergeInput): MergeResult {
  const { existing, title, fields, initialFields, body, related, date, replaceBody, historyEntry } = input;
  const trimmedBody = body.trim();
  const operation = input.operation ?? (replaceBody ? "SUPERSEDE" : existing === undefined ? "ADD" : "UPDATE");

  if (h2Sections(trimmedBody.split("\n"), "Related").length) {
    throw new Error("body must not contain ## Related; pass links through related");
  }
  if (replaceBody && operation !== "SUPERSEDE") {
    throw new Error("replaceBody is valid only for SUPERSEDE");
  }
  if (operation === "NOOP") {
    return { content: existing ?? "", action: "noop" };
  }
  if (operation === "ADD" && existing !== undefined) {
    throw new Error("ADD refuses to overwrite an existing card");
  }
  if ((operation === "UPDATE" || operation === "SUPERSEDE") && existing === undefined) {
    throw new Error(`${operation} requires an existing card`);
  }

  if (existing === undefined) {
    const all: FmFields = { ...fields, ...(initialFields || {}) };
    const fm = ["---", writeFrontmatter(all, []), "---", ""].join("\n");
    let out = `${fm}\n# ${title}\n\n${trimmedBody}\n`;
    if (related && related.length) out = mergeRelated(out, related);
    return { content: out, action: "created" };
  }

  const parsed = parseFrontmatter(existing);
  const oldBody = parsed.body;
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

  const fmText = parsed.fields
    ? writeFrontmatter(updates, parsed.lines)
    : writeFrontmatter(updates, []);

  let newBody = operation === "UPDATE" ? collapseLogSections(oldBody) : oldBody;
  let appended = false;
  if (operation === "SUPERSEDE") {
    newBody = `\n${replaceCompiledTruth(oldBody, trimmedBody, historyEntry, date).trim()}\n`;
  } else if (!bodyContains(oldBody, trimmedBody)) {
    newBody = appendLog(newBody, trimmedBody, date);
    appended = true;
  }
  if (!extractH1(newBody)) newBody = `# ${title}\n\n${newBody.replace(/^\s+/, "")}`;
  const beforeRelated = newBody;
  newBody = mergeRelated(newBody, related ?? []);
  if (beforeRelated !== newBody) appended = true;

  const content = `---\n${fmText}\n---\n${newBody.replace(/\s*$/, "")}\n`;
  return { content, action: operation === "SUPERSEDE" ? "replaced" : appended ? "merged" : "updated" };
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
    if (Date.now() > deadline) throw new Error(`Карточка занята другим процессом: ${lock}`);
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
