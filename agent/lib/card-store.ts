// Хранилище карточек: поиск существующего файла по идентичности, слияние (merge)
// нового содержимого со старым, лок + атомарная запись.
//
// Инвариант: write_card НИКОГДА не заменяет карточку целиком. Файл читается, известные
// поля frontmatter обновляются, неизвестные (tier/relevance/last_accessed/phone/…)
// сохраняются, created не трогается, старый body остаётся на месте.

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

/** Нормализация имени для сравнения: без уточнения в скобках, без пунктуации, lowercase. */
export function normalizeName(s: string): string {
  return s
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function extractH1(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
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

  const wanted = normalizeName(title);
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
    if (cands.some((c) => normalizeName(c) === wanted)) hits.push(full);
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

function relatedTargets(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) out.add(m[1].trim().toLowerCase());
  return out;
}

/** Дописать недостающие [[ссылки]] в секцию `## Related` (создать, если её нет). */
export function mergeRelated(body: string, related: string[]): string {
  const missing = related.filter((r) => !relatedTargets(body).has(r.trim().toLowerCase()));
  if (!missing.length) return body;
  const bullets = missing.map((r) => `- [[${r}]]`).join("\n");

  const lines = body.split("\n");
  const idx = lines.findIndex((l) => /^##\s+Related\s*$/i.test(l.trim()));
  if (idx === -1) return `${body.replace(/\s+$/, "")}\n\n## Related\n${bullets}\n`;

  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > idx + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, bullets);
  return lines.join("\n");
}

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
}

export interface MergeResult {
  content: string;
  action: "created" | "updated" | "merged";
}

export function mergeCard(input: MergeInput): MergeResult {
  const { existing, title, fields, initialFields, body, related, date } = input;
  const trimmedBody = body.trim();

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

  let newBody = oldBody;
  let appended = false;
  if (!bodyContains(oldBody, trimmedBody)) {
    newBody = `${newBody.replace(/\s+$/, "")}\n\n## Обновление ${date}\n\n${trimmedBody}\n`;
    appended = true;
  }
  if (!extractH1(newBody)) newBody = `# ${title}\n\n${newBody.replace(/^\s+/, "")}`;
  if (related && related.length) {
    const before = newBody;
    newBody = mergeRelated(newBody, related);
    if (before !== newBody) appended = true;
  }

  const content = `---\n${fmText}\n---\n${newBody.replace(/\s*$/, "")}\n`;
  return { content, action: appended ? "merged" : "updated" };
}

// ─── lock + атомарная запись ───────────────────────────────────────────────

const LOCK_STALE_MS = 15_000;

/** Простой lock-файл (O_EXCL). Достаточно против гонки двух ходов одного агента. */
export function acquireLock(file: string, timeoutMs = 5000): () => void {
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
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
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Карточка занята другим процессом: ${lock}`);
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
