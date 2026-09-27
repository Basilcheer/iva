import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { resolveVaultDir } from "@iva/vault-dir";
import { resolveDataDir } from "#lib/data-dir.ts";
import { resolveTimeZone } from "#lib/timezone.ts";
import { readSettings } from "#lib/settings.ts";
import { commitVaultSweep, commitVaultWrite } from "#lib/vault-commit.ts";
import { writeFileAtomicSync as writeAtomic } from "#lib/fs-atomic.ts";
import { imageRefsIn } from "#lib/attachment-ref.ts";
import { SECTION_KIND, setLastDayPointer } from "#lib/core-clamp.ts";
import { coreExcess, textHash, writeCore } from "#lib/core-write.ts";
import { hasUnclosedFence } from "#lib/card-text.ts";
import * as cs from "#lib/card-store.ts";
import * as fm from "#lib/frontmatter.ts";
import * as limits from "#lib/memory-night-constants.ts";
import { underMemoryLock } from "../lib/memory-lock.ts";
import { resolveStopAt } from "../lib/rollup-turn.ts";
import * as attempts from "../lib/rollup-attempts.ts";
import * as notice from "../lib/notice-policy.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";
import * as input from "./night-input.ts";
import type { DayEntry } from "./night-input.ts";

// Ночь (ADR-0016): код ведёт круг день → Card → связи → CORE, модель только судит.
// Каждая запись атомарна и коммитится; кэш дня спасает от второго платного вызова после
// обрыва. Строки факта Job — stderr; Alert и Report — швом Notice.

const root = process.cwd();
const dataDir = resolveDataDir(root, process.env.ASSISTANT_DATA_DIR);
const settings = readSettings(join(dataDir, "settings.json"));
if ((settings.memory as { night?: unknown } | undefined)?.night === "off") {
  console.error("memory-night: выключено");
  process.exit(0);
}
const vault = resolveVaultDir(root);
const locked = underMemoryLock(join(root, ".memory.lock"));
if (locked !== null) process.exit(locked);

const ATTEMPTS = join(dataDir, "rollup-attempts.json");
const CACHE_DIR = join(dataDir, "memory", "night");
const CORE_TEMPLATE =
  "# CORE\n\n## Пользователь\n\n## Предпочтения\n\n## Активные цели\n";
const DAY_MS = 86_400_000;
const jobs: string[] = [];
const alerts: string[] = [];
let call!: typeof import("./night-call.ts");
let signal!: AbortSignal;

// ── Схемы ответов: одна форма, терпимые; src — всегда список (строка принимается) ─────
const src = input.srcList;
const text = z.string().min(1);
const list = <T extends z.ZodType>(item: T) => z.array(item).default([]);
const cardType = z.enum(Object.keys(cs.TYPE_DIR) as [string, ...string[]]);
const newCard = z.object({
  name: text,
  type: cardType.catch("note"),
  description: z.string().default(""),
});
const dayAnswer = z.object({
  gist: z.string().default(""),
  topics: list(z.string()),
  points: list(z.object({ text, src })),
  new_cards: list(newCard),
  facts: list(
    z.object({ card: text, text, src, quote: z.string().default("") }),
  ),
  aliases: list(z.object({ card: text, alias: text, src })),
  links: list(z.object({ a: text, b: text, src })),
  core: list(z.object({ text, src })),
});
type DayAnswer = z.infer<typeof dayAnswer>;
type NewCard = z.infer<typeof newCard>;
const nullable = z.string().nullish();
const truthCard = z.object({
  card: text,
  truth: nullable,
  description: nullable,
  status: nullable,
});
type TruthCard = z.infer<typeof truthCard>;
const truthAnswer = z.object({ cards: list(truthCard) });
const coreAnswer = z.object({
  sections: list(z.object({ section: text, text: z.string() })),
});
type CoreAnswer = z.infer<typeof coreAnswer>;

// ── Кэш дня ──────────────────────────────────────────────────────────────────────────
type Candidate = { id: string; text: string; source: string };
/** pre — хеш файла при чтении для B (CAS), post — хеш записанного ночью. */
type TruthEntry = {
  pre: string;
  answer?: TruthCard;
  post?: string;
  done?: boolean;
};
interface Pass {
  readonly from: number;
  readonly upto: number;
  /** Ответы A по частям дня; выжимка — из последнего. */
  a?: DayAnswer[];
  /** Имя новой Card → путь: пишется до создания файла, повтор берёт ту же Card. */
  created: Record<string, string>;
  applied?: boolean;
  truth?: string[];
  b: Record<string, TruthEntry>;
}
interface DayCache {
  readonly v: 1;
  readonly date: string;
  through: number;
  prefixHash: string;
  touched: string[];
  core: Candidate[];
  coreDone?: boolean;
  /** Факты неписуемых Card: дописываются, когда Card поправили. */
  pending?: Record<string, string[]>;
  pass?: Pass;
  completedAt?: string;
}

/** Запись ночи — коммит vault; false — не закоммичено, следующая ночь докоммитит. */
const commit = async (message: string, files: string[]) =>
  (await commitVaultWrite(message, files, vault)).ok;

const cacheFile = (date: string) => join(CACHE_DIR, `${date}.json`);

function readCache(date: string): DayCache | null {
  try {
    const value = JSON.parse(readFileSync(cacheFile(date), "utf8")) as DayCache;
    const valid = value.v === 1 && value.date === date;
    return valid && Number.isSafeInteger(value.through) ? value : null;
  } catch {
    return null;
  }
}

function writeCache(cache: DayCache): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeAtomic(cacheFile(cache.date), `${JSON.stringify(cache)}\n`, {
    mode: 0o600,
  });
}

const cacheDates = () =>
  existsSync(CACHE_DIR)
    ? readdirSync(CACHE_DIR).flatMap(
        (name) => /^(\d{4}-\d{2}-\d{2})\.json$/u.exec(name)?.[1] ?? [],
      )
    : [];

// ── Card ─────────────────────────────────────────────────────────────────────────────
interface Card {
  readonly card: string;
  readonly file: string;
  readonly name: string;
  readonly aliases: string[];
  readonly fields: fm.FmFields;
  readonly body: string;
  readonly raw: string;
}

const cardFile = (card: string) => join(vault, `${card}.md`);
const str = (fields: fm.FmFields | null | undefined, key: string) =>
  typeof fields?.[key] === "string" ? fields[key] : "";
const logDate = (row: string) =>
  /^- (\d{4}-\d{2}-\d{2}):/u.exec(row)?.[1] ?? "";
const namesOf = (card: Card) =>
  [card.name, basename(card.file, ".md"), ...card.aliases].map(
    cs.normalizeName,
  );
const render = (fields: fm.FmFields, body: string) =>
  `---\n${fm.writeFrontmatter(fields, [])}\n---\n${body.trim()}\n`;

function readCard(card: string): Card | null {
  const file = cardFile(card);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  const parsed = fm.parseFrontmatterOrSkip(raw, file, (row) => jobs.push(row));
  if (!parsed) return null;
  const { body, fields = {} } = parsed;
  const name = cs.extractH1(body) ?? basename(file, ".md");
  const aliases = cs.aliasList(fields?.aliases);
  return { card, file, name, aliases, fields: fields ?? {}, body, raw };
}

const readCards = () =>
  cs
    .listCardFiles(vault)
    .flatMap((file) => readCard(file.slice(vault.length + 1, -3)) ?? []);

/** Card, которую ночь может дописать: frontmatter цел, фенсы закрыты, Log один. */
function writable(card: string): Card | null {
  const found = readCard(card);
  if (!found || hasUnclosedFence(found.body)) return null;
  return cs.sectionRows(found.body, "Log") === null ? null : found;
}

/** Факты в Log без повторов (сравнение без даты и указателя). */
function withFacts(body: string, rows: readonly string[]): string {
  const log = cs.sectionRows(body, "Log") ?? [];
  const keys = new Set(log.map(cs.logFactKey));
  const fresh = [...new Set(rows)].filter(
    (row) => !keys.has(cs.logFactKey(row)),
  );
  return fresh.length
    ? cs.replaceH2Sections(body, "Log", [...log, ...fresh])
    : body;
}

// ── Отложенные факты неписуемых Card живут в кэше дня ────────────────────────────
function queuePending(cache: DayCache, card: string, rows: readonly string[]) {
  cache.pending = {
    ...cache.pending,
    [card]: [...(cache.pending?.[card] ?? []), ...rows],
  };
  writeCache(cache);
  alerts.push(
    `Поправь Card ${card}: frontmatter, блок кода или Log; факты ждут`,
  );
}

async function applyPending(): Promise<void> {
  for (const cache of cacheDates().flatMap((date) => readCache(date) ?? [])) {
    for (const [card, rows] of Object.entries(cache.pending ?? {})) {
      const found = writable(card);
      if (!found) {
        alerts.push(`Поправь Card ${card}: факты ждут`);
        continue;
      }
      writeAtomic(
        found.file,
        render(found.fields, withFacts(found.body, rows)),
      );
      if (!(await commit(`${card}: pending facts`, [found.file])))
        throw new Error(`${card}: отложенные факты не закоммичены`);
      delete cache.pending![card];
      writeCache(cache);
    }
  }
}

// ── Step 1: день (вызов A) ───────────────────────────────────────────────────────────
const localDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(process.env.ASSISTANT_TIMEZONE),
  }).format(new Date());
const skill = (name: string) =>
  readFileSync(
    join(root, "scripts/memory/instructions/night", `${name}.md`),
    "utf8",
  );
const dailyFile = (date: string) => join(vault, "daily", `${date}.md`);
const summaryFile = (date: string) =>
  join(vault, "summaries/daily", `${date}.md`);
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** Известные Card: совпавшие по имени целиком — подробно; остальные contact, project
 * и свежие decision/idea — коротким индексом. */
function knownFor(cards: readonly Card[], dayText: string, date: string) {
  const haystack = ` ${cs.normalizeName(dayText)} `;
  return cards.flatMap((card) => {
    const type = str(card.fields, "type");
    const short = { card: card.card, type, name: card.name };
    const log = cs.sectionRows(card.body, "Log") ?? [];
    if (namesOf(card).some((n) => n.length >= 3 && haystack.includes(` ${n} `)))
      return {
        ...short,
        aliases: card.aliases,
        description: str(card.fields, "description").slice(0, 160),
        truth: cs.truthOf(card.body).slice(0, 300),
        today: log.filter((row) => logDate(row) === date),
      };
    const fresh = str(card.fields, "created") >= shift(date, -30);
    const active = fresh && str(card.fields, "status") !== "superseded";
    return ["contact", "project"].includes(type) || active ? [short] : [];
  });
}

/** Строго только то, без чего запись опасна: Card существует или новая, у факта
 * дословная цитата из реплики владельца. Негодное отбрасывается по одному (строка в
 * факте Job); неизвестные номера реплик отпадают. */
function usable(answer: DayAnswer, entries: DayEntry[], cards: Card[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const names = new Set(cards.map((card) => card.card));
  answer.new_cards.forEach((card) => names.add(card.name));
  const said = (ids: string[], quote: string) =>
    ids.some((id) => input.quoteBelongsTo(byId.get(id)!, quote));
  type Item = { src: string[] };
  const keep = <T extends Item>(
    items: T[],
    ok: (item: T) => boolean = () => true,
  ) =>
    items.flatMap((item) => {
      const found = { ...item, src: item.src.filter((id) => byId.has(id)) };
      if (found.src.length > 0 && ok(found)) return [found];
      jobs.push(`отброшено: ${JSON.stringify(item)}`);
      return [];
    });
  return {
    ...answer,
    points: keep(answer.points),
    facts: keep(answer.facts, (f) => names.has(f.card) && said(f.src, f.quote)),
    aliases: keep(
      answer.aliases,
      (a) => names.has(a.card) && said(a.src, a.alias),
    ),
    links: keep(answer.links, (l) => names.has(l.a) && names.has(l.b)),
    core: keep(answer.core),
  };
}

/** A по частям дня; часть видит выжимку предыдущих и пишет выжимку всего дня. */
async function askDay(
  date: string,
  day: DayEntry[],
  cards: Card[],
  context: string[],
) {
  const answers: DayAnswer[] = [];
  for (const entries of input.splitEntries(day, limits.PART_SIZE)) {
    const text = [...entries.map((entry) => entry.text), ...context].join("\n");
    const known = knownFor(cards, text, date);
    const earlier_parts = answers.map((answer) => answer.gist);
    const data = { date, entries, known, previous: context[0], earlier_parts };
    const ask = { skill: skill("day"), input: data, schema: dayAnswer, signal };
    answers.push(usable(await call.callBySchema(ask), day, cards));
  }
  return answers;
}

// ── Step 2–3: Card и связи ───────────────────────────────────────────────────────────
function mergeAliases(draft: Draft, values: string[]): void {
  const aliases = cs.aliasList(draft.fields.aliases);
  for (const value of values.map((alias) => cs.sanitizeField(alias, 80)))
    if (
      !aliases.map(cs.aliasKey).includes(cs.aliasKey(value)) &&
      aliases.length < cs.ALIASES_MAX
    )
      aliases.push(value);
  if (aliases.length) draft.fields.aliases = aliases;
}
type Draft = {
  file: string;
  fields: fm.FmFields;
  body: string;
  before: string;
};

/** Card дня в памяти до записи: читается раз, пишется одним коммитом шага. */
class Day {
  readonly drafts = new Map<string, Draft | null>();
  readonly cards = readCards();
  readonly touched = new Set<string>();
  readonly times: Map<string, string>;
  readonly cache: DayCache;
  constructor(cache: DayCache, entries: DayEntry[]) {
    this.cache = cache;
    this.times = new Map(entries.map((entry) => [entry.id, entry.time]));
  }

  draft(card: string, create?: () => Draft): Draft | null {
    if (!this.drafts.has(card)) {
      const found = writable(card);
      const fresh = create && !existsSync(cardFile(card)) ? create() : null;
      this.drafts.set(card, found ? { ...found, before: found.raw } : fresh);
    }
    return this.drafts.get(card)!;
  }

  write(): string[] {
    return [...this.drafts.values()].flatMap((draft) => {
      const next = draft ? render(draft.fields, draft.body) : "";
      if (!draft || next === draft.before) return [];
      mkdirSync(dirname(draft.file), { recursive: true });
      writeAtomic(draft.file, next);
      return [draft.file];
    });
  }

  /** Путь новой Card: из кэша дня или по свободному имени; занятое имя — `Имя (D)` и
   * Alert. null — на месте лежит чужой файл, он не затирается. */
  newCard(item: NewCard): string | null {
    const { pass, date } = { pass: this.cache.pass!, date: this.cache.date };
    const key = cs.normalizeName(item.name);
    let name = cs.sanitizeField(item.name, 160);
    const taken = this.cards.some((card) => namesOf(card).includes(key));
    if (!pass.created[key]) {
      if (taken) alerts.push(`Похоже на дубль: ${item.name}. Склеить Card?`);
      const card = `cards/${cs.TYPE_DIR[item.type]}/${cs.slugify(taken ? `${name} (${date})` : name)}`;
      if (existsSync(cardFile(card))) return null;
      pass.created[key] = card;
      writeCache(this.cache);
    }
    const card = pass.created[key];
    if (!card.endsWith(`/${cs.slugify(name)}`)) name = `${name} (${date})`;
    const [type, source] = [item.type, `daily/${date}.md`];
    const description = cs.sanitizeField(item.description);
    const fields = { type, description, tags: [type], status: "active" };
    Object.assign(fields, { created: date, source });
    const body = `# ${name}\n\n## Log\n\n## Related\n\n## History\n`;
    const file = cardFile(card);
    return this.draft(card, () => ({ file, fields, body, before: "" })) && card;
  }

  cardOf(answer: DayAnswer, name: string): string | null {
    if (this.cards.some((card) => card.card === name)) return name;
    const item = answer.new_cards.find((card) => card.name === name);
    return item ? this.newCard(item) : null;
  }

  /** Факты и алиасы в Card; неписуемая Card — факты в pending и Alert. */
  facts(answer: DayAnswer): void {
    const date = this.cache.date;
    const row = (fact: DayAnswer["facts"][number]) =>
      `- ${date}: ${cs.sanitizeField(fact.text)} · [[daily/${date}]] ${this.times.get(fact.src[0])}`;
    const names = [...answer.facts, ...answer.aliases].map((item) => item.card);
    for (const name of new Set(names)) {
      const rows = answer.facts.filter((f) => f.card === name).map(row);
      const card = this.cardOf(answer, name);
      const draft = card ? this.draft(card) : null;
      if (!draft) {
        if (rows.length)
          queuePending(this.cache, card ?? `cards/${cs.slugify(name)}`, rows);
        continue;
      }
      draft.body = withFacts(draft.body, rows);
      const aliases = answer.aliases.filter((item) => item.card === name);
      mergeAliases(
        draft,
        aliases.map((alias) => alias.alias),
      );
      if (rows.length) this.touched.add(card!);
    }
  }

  /** Связь пишется в Related обеих Card, если оба файла есть. */
  links(answer: DayAnswer): void {
    for (const link of answer.links) {
      const [a, b] = [this.cardOf(answer, link.a), this.cardOf(answer, link.b)];
      const ends = a && b && a !== b ? [this.draft(a), this.draft(b)] : [];
      const ready = ends.every((draft) => draft && existsSync(draft.file));
      if (ends.length !== 2 || !ready) {
        jobs.push(`связь ${link.a} ↔ ${link.b} не записана: файла Card нет`);
        continue;
      }
      const pairs = [
        [ends[0]!, b!],
        [ends[1]!, a!],
      ] as const;
      for (const [draft, other] of pairs) {
        const related = cs.sectionRows(draft.body, "Related") ?? [];
        if (related.length < limits.RELATED_MAX)
          draft.body = cs.mergeRelated(draft.body, [other]);
        else jobs.push(`${other}: Related заполнен`);
      }
    }
  }
}

/** B получает Card с новым фактом и Card с truth_pending ≤ D. */
function truthCandidates(touched: ReadonlySet<string>, date: string): string[] {
  const due = (card: Card) => {
    const since = str(card.fields, "truth_pending");
    return touched.has(card.card) || (since !== "" && since <= date);
  };
  return readCards()
    .filter(due)
    .map((card) => card.card);
}

async function applyCards(
  cache: DayCache,
  entries: DayEntry[],
): Promise<boolean> {
  const day = new Day(cache, entries);
  for (const answer of cache.pass!.a!) day.facts(answer);
  const files = day.write();
  for (const answer of cache.pass!.a!) day.links(answer);
  files.push(...day.write());
  if (!(await commit(`memory day ${cache.date}: Card`, files))) return false;
  cache.touched = [...new Set([...cache.touched, ...day.touched])];
  cache.pass!.truth = truthCandidates(day.touched, cache.date);
  return true;
}

// ── Step 2: правда Card (вызов B) ────────────────────────────────────────────────────
function statuses(type: string): string[] {
  try {
    const schema = JSON.parse(
      readFileSync(join(vault, "schema.json"), "utf8"),
    ) as {
      node_types?: Record<string, { status?: string[] }>;
    };
    return schema.node_types?.[type]?.status ?? [];
  } catch {
    return [];
  }
}

function truthInput(card: Card, date: string) {
  const log = cs.sectionRows(card.body, "Log") ?? [];
  const since = str(card.fields, "truth_pending") || date;
  const at = (row: string) => logDate(row) >= since && logDate(row) <= date;
  const [truth, get] = [
    cs.truthOf(card.body),
    (key: string) => str(card.fields, key),
  ];
  return {
    ...{
      card: card.card,
      name: card.name,
      truth,
      truth_date: get("truth_date"),
    },
    ...{ description: get("description"), status: get("status") },
    ...{
      statuses: statuses(get("type")),
      log: log.slice(-10),
      facts: log.filter(at),
    },
  };
}

async function askTruth(cache: DayCache): Promise<void> {
  const { pass, date } = { pass: cache.pass!, date: cache.date };
  const waiting = (pass.truth ?? []).filter((card) => !pass.b[card]);
  for (let at = 0; at < waiting.length; at += limits.CARDS_PER_TRUTH_CALL) {
    const batch = waiting
      .slice(at, at + limits.CARDS_PER_TRUTH_CALL)
      .flatMap((card) => readCard(card) ?? []);
    const data = { date, cards: batch.map((card) => truthInput(card, date)) };
    const ask = {
      skill: skill("card"),
      input: data,
      schema: truthAnswer,
      signal,
    };
    let answer: TruthCard[] = [];
    try {
      answer = (await call.callBySchema(ask)).cards;
    } catch (error) {
      if (!(error instanceof call.NightSchemaError)) throw error;
      jobs.push(`${date}: ответ B не по форме, правда ждёт следующей ночи`);
    }
    for (const card of batch)
      pass.b[card.card] = {
        pre: textHash(card.raw),
        answer: answer.find((a) => a.card === card.card),
      };
    writeCache(cache);
  }
}

/** Card по ответу B: правда и description целиком, прежнее дословно в History. */
function truthApplied(
  card: Card,
  answer: TruthCard,
  date: string,
): string | null {
  const fields: fm.FmFields = { ...card.fields, truth_date: date };
  delete fields.truth_pending;
  let body = card.body;
  const moved: string[] = [];
  if (typeof answer.truth === "string") {
    const next = answer.truth
      .split("\n")
      .map((line) => cs.sanitizeField(line))
      .filter(Boolean)
      .join("\n");
    moved.push(...cs.disappearedLines(cs.truthOf(body), next));
    body = cs.withTruth(body, next);
  }
  const before = str(card.fields, "description");
  const description = cs.sanitizeField(answer.description ?? "") || before;
  if (before && description !== before) moved.push(before);
  if (description) fields.description = description;
  if (answer.status) fields.status = cs.sanitizeField(answer.status, 40);
  const history = cs.sectionRows(body, "History");
  if (history === null) return null;
  const rows = moved.map(
    (line) => `- ${date}: ${line} (сменено: [[daily/${date}]])`,
  );
  return render(
    fields,
    rows.length
      ? cs.replaceH2Sections(body, "History", [...history, ...rows])
      : body,
  );
}

/** CAS: файл тот же, что при чтении для B, — правка целиком. Иначе правка человека
 * побеждает: ответ стирается, Card получает truth_pending, B — следующей ночью. */
function applyTruthCard(cache: DayCache, card: string, entry: TruthEntry) {
  const current = readCard(card);
  const hash = current ? textHash(current.raw) : "";
  if (entry.done || hash === entry.post) return null;
  const answer = hash === entry.pre ? entry.answer : undefined;
  const next = answer ? truthApplied(current!, answer, cache.date) : null;
  if (next === null) return giveUp(cache, card, entry, current);
  entry.post = textHash(next);
  writeCache(cache);
  if (next === current!.raw) return null;
  writeAtomic(current!.file, next);
  return current!.file;
}

/** Ответ не применим (правка человека, неоднозначная History, нет ответа): ответ
 * стирается, Card получает truth_pending. */
function giveUp(
  cache: DayCache,
  card: string,
  entry: TruthEntry,
  current: Card | null,
) {
  if (!current || textHash(current.raw) !== entry.pre)
    alerts.push(
      `${card}: Compiled Truth изменён человеком, ночь его не перетёрла`,
    );
  delete entry.answer;
  entry.done = true;
  writeCache(cache);
  const pending = str(current?.fields, "truth_pending");
  if (!current || (pending && pending <= cache.date)) return null;
  const fields = { ...current.fields, truth_pending: cache.date };
  writeAtomic(current.file, render(fields, current.body));
  return current.file;
}

async function applyTruth(cache: DayCache): Promise<boolean> {
  await askTruth(cache);
  const entries = Object.entries(cache.pass!.b);
  const files = entries.flatMap(
    ([card, entry]) => applyTruthCard(cache, card, entry) ?? [],
  );
  const message = `memory day ${cache.date}: Compiled Truth`;
  if (!(await commit(message, files))) return false;
  for (const [, entry] of entries) entry.done = true;
  writeCache(cache);
  return true;
}

// ── Выжимка дня: пишется последней, вместе с отметкой конца в сыром дне ─────────────
function summaryOf(cache: DayCache, entries: DayEntry[], raw: string): string {
  const { date, pass } = { date: cache.date, pass: cache.pass! };
  const last = pass.a!.at(-1);
  const time = new Map(entries.map((entry) => [entry.id, entry.time]));
  const at = (src: string[]) => src.map((id) => time.get(id)).join(", ");
  const points = (last?.points ?? []).map(
    (point) => `- ${point.text} · [[daily/${date}]] ${at(point.src)}`,
  );
  const cards = cache.touched.map((card) => `- [[${card}]]`);
  const files = [...new Set(imageRefsIn(raw))].map((path) => `- [[${path}]]`);
  const attached = files.length ? ["", "## Вложения", "", ...files] : [];
  const listed = cards.length ? cards : ["- Нет"];
  const body = [`# ${date}`, "", ...points, "", "## Карточки дня", ""];
  const inputs = entries.slice(pass.from, pass.upto);
  const hash = { v: 1, step: "A", model: call.nightModelName, inputs };
  const topics = last?.topics ?? [];
  const fields = {
    type: "daily-summary",
    date,
    description: last?.gist || `Нет своих реплик за ${date}`,
    topics,
    tags: topics.length ? topics : ["daily"],
    source: "night",
    input_hash: input.canonicalHash(hash),
    through: String(pass.upto),
  };
  const text = [...body, ...listed, ...attached, ""].join("\n");
  return input.summaryText(fields, text);
}

async function finishDay(cache: DayCache, entries: DayEntry[], raw: string) {
  const { date, pass } = { date: cache.date, pass: cache.pass! };
  const [summary, daily] = [summaryFile(date), dailyFile(date)];
  mkdirSync(dirname(summary), { recursive: true });
  writeAtomic(summary, summaryOf(cache, entries, raw));
  // Совместимая отметка конца дня: старая ночь после отката не переразбирает день.
  const shim = `\n<!-- processed: memory-night ${date} -->\n`;
  if (!input.markedDone(readFileSync(daily, "utf8")))
    appendFileSync(daily, shim);
  if (!(await commit(`memory day ${date}: ready`, [summary, daily])))
    return false;
  const time = new Map(entries.map((entry) => [entry.id, entry.time]));
  pass
    .a!.flatMap((answer) => answer.core)
    .forEach((item, index) => {
      const id = `${date}:${pass.from}:${index + 1}`;
      const source = `[[daily/${date}]] ${time.get(item.src[0])}`;
      cache.core.push({ id, text: item.text, source });
      cache.coreDone = false;
    });
  cache.through = pass.upto;
  cache.prefixHash = input.prefixHash(entries, pass.upto);
  cache.completedAt = new Date().toISOString();
  delete cache.pass;
  writeCache(cache);
  attempts.clearDay(ATTEMPTS, date);
  return true;
}

// ── День целиком ─────────────────────────────────────────────────────────────────────
function openPass(date: string, entries: DayEntry[]): DayCache | null {
  const cache = readCache(date);
  if (cache?.pass) return cache;
  if (cache && entries.length <= cache.through) return null;
  const base = cache ?? {
    ...{ v: 1 as const, date, through: 0, touched: [], core: [] },
    prefixHash: input.prefixHash(entries, 0),
  };
  const from = base.through;
  const pass = { from, upto: entries.length, created: {}, b: {} };
  const core = base.coreDone ? [] : base.core;
  const next: DayCache = { ...base, core, coreDone: undefined, pass };
  // Кэш пишется до вызова: не пишется — вызова нет (иначе обрыв дал бы второй вызов).
  writeCache(next);
  return next;
}

function fail(row: string): false {
  jobs.push(row);
  return false;
}

const readIf = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8") : null;

function gistOf(date: string): string {
  const text = readIf(summaryFile(date));
  const fields =
    text === null
      ? null
      : fm.parseFrontmatterOrSkip(text, summaryFile(date))?.fields;
  return str(fields, "description");
}

/** Вызов A для прохода дня; поздний хвост видит выжимку дня и тронутые днём Card. */
async function askPass(cache: DayCache, entries: DayEntry[]) {
  const pass = cache.pass!;
  const part = entries.slice(pass.from, pass.upto);
  if (!part.some((entry) => entry.origin === "owner")) return [];
  const cards = readCards();
  const seen = cards.filter((card) => cache.touched.includes(card.card));
  const context = [
    pass.from ? gistOf(cache.date) : "",
    ...seen.map((c) => c.name),
  ];
  return await askDay(cache.date, part, cards, context);
}

async function processDay(date: string): Promise<boolean> {
  const raw = readIf(dailyFile(date));
  if (raw === null) return !fail(`${date}: нет данных`);
  const entries = input.parseDay(raw);
  const cache = openPass(date, entries);
  if (!cache?.pass) return true;
  cache.pass.a ??= await askPass(cache, entries);
  writeCache(cache);
  if (!cache.pass.applied && !(await applyCards(cache, entries)))
    return fail(`${date}: Card не закоммичены`);
  cache.pass.applied = true;
  writeCache(cache);
  if (!(await applyTruth(cache))) return fail(`${date}: правда не закоммичена`);
  if (await finishDay(cache, entries, raw)) return true;
  return fail(`${date}: выжимка не закоммичена`);
}

/** Нужен ли дню разбор. Выжимка без body_hash (старая ночь) — день готов: граница
 * перехода; правленая руками — не трогается. */
function dayTodo(date: string): boolean {
  const raw = readFileSync(dailyFile(date), "utf8");
  const cache = readCache(date);
  const entries = input.parseDay(raw);
  if (cache?.pass) return true;
  if (cache && input.prefixHash(entries, cache.through) !== cache.prefixHash)
    return fail(
      `день ${date} изменён после разбора; удали ${cacheFile(date)} и запусти ночь за ${date}`,
    );
  const summary = readIf(summaryFile(date));
  if (summary !== null && input.summaryEdited(summary))
    return fail(`выжимка ${date} изменена вручную; день не разбирается`);
  if (cache) return entries.length > cache.through;
  return summary === null && !input.markedDone(raw);
}

function dayQueue(today: string): string[] {
  const tried = attempts.readAttempts(ATTEMPTS);
  const dir = join(vault, "daily");
  const dates = existsSync(dir) ? readdirSync(dir) : [];
  return dates
    .flatMap((name) => /^(\d{4}-\d{2}-\d{2})\.md$/u.exec(name)?.[1] ?? [])
    .filter((date) => date < today && !attempts.isExhausted(tried[date]))
    .sort()
    .filter(dayTodo);
}

// ── Step 4: CORE (вызов C) ───────────────────────────────────────────────────────────
/** Ночью меняются только разделы шаблона CORE; разделы владельца и указатели — нет. */
const editable = (head: string) =>
  ["user", "preferences", "goals"].includes(
    SECTION_KIND.get(head.slice(3).trim()) ?? "",
  );
const coreParts = (core: string) => core.split(/^(?=## )/mu);

function coreSections(core: string): Record<string, string> {
  const parts = coreParts(core).map((part) => part.split("\n"));
  const kept = parts.filter(
    ([head]) => head.startsWith("## ") && editable(head),
  );
  return Object.fromEntries(
    kept.map(([head, ...rows]) => [
      head.slice(3).trim(),
      rows.filter((row) => row.trim()).join("\n"),
    ]),
  );
}

/** CORE с разделами из ответа C целиком; длина сверх лимита — повтор с «освободи N». */
function coreApplied(before: string, answer: CoreAnswer): string {
  const next = coreParts(before).map((part) => {
    const head = part.split("\n", 1)[0];
    const text = answer.sections.find(
      (item) => `## ${item.section}` === head.trim(),
    )?.text;
    if (text === undefined || !editable(head)) return part;
    const rows = text
      .split("\n")
      .filter((row) => row.trim() && !row.startsWith("#"));
    return `${head}\n\n${rows.map((row) => `${row}\n`).join("")}\n`;
  });
  const excess = coreExcess(before, next.join(""), "night");
  if (excess > 0)
    throw new Error(`CORE длиннее лимита: освободи ${excess} знаков`);
  return next.join("");
}

/** Кандидаты CORE из кэша дней; применённые отмечаются только после коммита CORE. */
/** Ответ C, применённый к CORE; null — отказ формы или Ceiling, кандидаты ждут. */
async function askCore(before: string, candidates: Candidate[]) {
  const data = { sections: coreSections(before), candidates };
  const validate = (value: CoreAnswer) => void coreApplied(before, value);
  const ask = {
    skill: skill("core"),
    input: data,
    schema: coreAnswer,
    signal,
    validate,
  };
  try {
    return coreApplied(before, await call.callBySchema(ask));
  } catch (error) {
    const known =
      error instanceof call.NightSchemaError ||
      error instanceof call.NightCeilingError;
    if (!known) throw error;
    alerts.push(
      `CORE не обновлён, кандидаты ждут следующей ночи: ${error.message}`,
    );
    return null;
  }
}

/** Кандидаты CORE из кэша дней; применённые отмечаются только после коммита CORE. */
/** Дни с кандидатами CORE, ещё не применёнными. */
const coreWaiting = () =>
  cacheDates()
    .flatMap((date) => readCache(date) ?? [])
    .filter((cache) => !cache.pass && !cache.coreDone && cache.core.length);

async function runCore(lastDay: string | undefined): Promise<void> {
  const waiting = coreWaiting();
  const before = readIf(join(vault, "CORE.md")) ?? "";
  const base = before || CORE_TEMPLATE;
  const candidates = waiting.flatMap((cache) => cache.core);
  const asked = candidates.length ? await askCore(base, candidates) : null;
  const written = await writeNightCore(before, asked ?? base, lastDay);
  if (!written || asked === null) return;
  for (const cache of waiting) writeCache({ ...cache, coreDone: true });
}

/** CORE ночи с указателем «Последний день»; пустой шаблон без правок не создаётся. */
async function writeNightCore(before: string, draft: string, lastDay?: string) {
  const next = lastDay ? setLastDayPointer(draft, lastDay) : draft;
  if (next === CORE_TEMPLATE) return false;
  const date = lastDay ?? localDate();
  const reason = `night ${date}`;
  const expectedHash = textHash(before);
  const result = await writeCore({
    vault,
    next,
    reason,
    date,
    expectedHash,
    mode: "night",
  });
  if (!result.ok) jobs.push(`CORE не записан: ${result.error}`);
  return result.ok;
}

// ── Alert и Report — существующим швом Notice (дроссель alertDue, Outbox) ───────────
function telegram() {
  const [bot, chat] = [process.env.TELEGRAM_BOT_TOKEN, notificationChat()];
  return bot && chat
    ? (body: string) =>
        sendTelegramHtml(bot, chat, body, { trace: { source: "rollup" } })
    : null;
}

async function notify(key: string, body: string): Promise<void> {
  const send = telegram();
  await notice.alertOnce(dataDir, key, body, async () => {
    const sent = send ? await send(body) : { ok: false, error: "нет чата" };
    if (!sent.ok)
      console.error(`memory-night alert ${key}: ${body} (${sent.error})`);
    return sent.ok;
  });
}

async function report(done: readonly string[]): Promise<void> {
  const send = telegram();
  const lines = done.map((date) => `${date}: ${gistOf(date)}`);
  const delivery = await notice.deliverMemoryReport({
    dataDir,
    settings,
    ranBefore: notice.rollupRanBefore(dataDir, vault),
    report: ["Ночь памяти", ...lines, ...jobs].join("\n"),
    tr: await notice.noticeTranslator(),
    send: send ? { report: send, notice: send } : null,
  });
  if (delivery.status === "failed")
    console.error(`memory-night: Report: ${delivery.error}`);
}

/** Вчера нет сырого дня, а в usage.jsonl есть ходы чата — транскрипт не записался. */
function transcriptLost(today: string): string {
  const [day, usage] = [shift(today, -1), join(dataDir, "usage.jsonl")];
  if (existsSync(dailyFile(day)) || !existsSync(usage)) return "";
  const chat = (row: string) => !row.includes('"source":"memory-night"');
  const rows = readFileSync(usage, "utf8").split("\n");
  return rows.some((row) => row.includes(`"ts":"${day}`) && chat(row))
    ? day
    : "";
}

async function alertsAtEnd(today: string, fallbacks: readonly string[]) {
  const tried = attempts.readAttempts(ATTEMPTS);
  const paused = Object.keys(tried).filter((d) =>
    attempts.isExhausted(tried[d]),
  );
  const old = dayQueue(today).filter((date) => date < shift(today, -7));
  const lost = transcriptLost(today);
  const russian = (_english: string, body: string) => body;
  const pausedText = attempts.dayPausedAlert(russian, paused, tried);
  const all: Array<[string, unknown, string]> = [
    [attempts.DAY_PAUSED_ALERT_KEY, paused.length, pausedText],
    [
      "night-fallback",
      fallbacks.length,
      `Периоды собраны без модели: ${fallbacks.join(", ")}`,
    ],
    ["night-pending", alerts.length, alerts.join("\n")],
    [
      "night-tail",
      old.length,
      `Очередь ночи старше 7 дней: ${old.join(", ")}. Проверь iva jobs.`,
    ],
    [
      "night-transcript",
      lost,
      `За ${lost} нет сырого дня, хотя чат работал. Проверь vault/daily.`,
    ],
  ];
  for (const [key, due, body] of all) if (due) await notify(key, body);
}

// ── Ночь ─────────────────────────────────────────────────────────────────────────────
function cleanupCaches(): void {
  for (const cache of cacheDates().flatMap((date) => readCache(date) ?? [])) {
    const age = Date.now() - Date.parse(cache.completedAt ?? "");
    const pending = Object.keys(cache.pending ?? {}).length;
    const waiting =
      cache.pass || pending || (cache.core.length && !cache.coreDone);
    if (waiting || !(age >= limits.CACHE_DAYS * DAY_MS)) continue;
    try {
      rmSync(cacheFile(cache.date));
    } catch (error) {
      jobs.push(`кэш ${cache.date} не очищен: ${String(error)}`);
    }
  }
}

async function runDays(dates: readonly string[]) {
  const done: string[] = [];
  const attempt = (date: string, reason: attempts.AttemptReason) =>
    attempts.addAttempt(ATTEMPTS, date, reason, new Date().toISOString());
  for (const date of dates)
    try {
      if (!(await processDay(date)))
        return { done, code: 1, stop: attempt(date, "day-unfinished") };
      done.push(date);
    } catch (error) {
      if (error instanceof call.NightCeilingError) {
        console.error(`memory-night: обрез пределом ночи на ${date}`);
        return { done, code: 1, stop: attempt(date, "cut") };
      }
      if (!(error instanceof call.NightSchemaError)) throw error;
      attempt(date, "no-report");
      jobs.push(`${date}: ответ A не по форме после повтора: ${error.message}`);
    }
  return { done, code: done.length === dates.length ? 0 : 1 };
}

async function night(manual: string | undefined): Promise<number> {
  const sweep = await commitVaultSweep("memory-night: до ночи", vault);
  if (!sweep.ok)
    throw new Error(`vault не закоммичен до ночи: ${sweep.reason}`);
  try {
    call = await import("./night-call.ts");
  } catch (error) {
    await notify(
      "night-model",
      `Ночная память не запускает модель: ${String(error)}`,
    );
    throw error;
  }
  const { buildReadyPeriods } = await import("./night-periods.ts");
  await applyPending();
  const today = localDate();
  const ask = { skill: skill("period"), model: call.nightModelName, signal };
  const periods = async (): Promise<string[]> =>
    manual ? [] : buildReadyPeriods(vault, today, ask, jobs);
  const fallbacks = await periods();
  const tried = attempts.readAttempts(ATTEMPTS);
  const queue = manual
    ? [manual]
    : dayQueue(today).slice(0, limits.DAYS_PER_NIGHT);
  const ready = queue.filter((date) => !attempts.isExhausted(tried[date]));
  const { done, code } = await runDays(ready);
  await runCore(done.at(-1));
  fallbacks.push(...(await periods()));
  cleanupCaches();
  await alertsAtEnd(today, fallbacks);
  if (done.length) await report(done);
  const { calls, inputTokens, unknownUsage, usageLost } = call.ceiling;
  if (usageLost) jobs.push(`usage.jsonl не записан: ${usageLost}`);
  const usage = `${calls} call(s), ${inputTokens} input tokens`;
  const unknown = unknownUsage ? ", usage unknown" : "";
  console.error(`memory-night: ${done.length} day(s), ${usage}${unknown}`);
  return code;
}

async function main(): Promise<number> {
  const manual = process.argv[2];
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(manual ?? "") ? manual : "";
  if (manual !== undefined && (!date || shift(date, 0) !== date)) {
    console.error("Usage: night.ts [YYYY-MM-DD]");
    return 1;
  }
  const controller = new AbortController();
  signal = controller.signal;
  const stopAt = resolveStopAt(process.env.IVA_JOB_STOP_AT, Date.now());
  const stop = () => controller.abort(new Error("memory-night deadline"));
  const timer = setTimeout(stop, Math.max(1, stopAt - Date.now()));
  try {
    return await night(manual);
  } catch (error) {
    console.error(
      `memory-night: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    clearTimeout(timer);
    for (const row of jobs) console.error(`memory-night: ${row}`);
  }
}

process.exitCode = await main();
