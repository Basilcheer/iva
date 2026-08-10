// Карточка vault'а → текст, по которому её ищут. Одно место на ОБЕ половины поиска:
// BM25-колонки (agent/tools/memory_search.ts) и dense-эмбеддинги сайдкар-индекса
// (scripts/memory/embed-index.ts). Разъехавшись, половины в режиме hybrid ранжируют
// разный текст одной и той же карточки — ровно это делала своя копия мини-парсера в
// embed-index: теряла свёрнутые скаляры, блочные списки и карточки с CRLF.
// Разбор frontmatter — только канонический parseFrontmatter (см. docs/tech-debt.md §13).

import { parseFrontmatter } from "./frontmatter.ts";

// Поля фронтматтера, несущие искомый смысл структурированных карточек (контакты/проекты).
// BM25 индексирует их отдельной колонкой с высоким весом — иначе поиск по имени/компании
// из фронтматтера промахивается (в body их может не быть).
const META_FIELDS = [
  "name",
  "company",
  "role",
  "description",
  "handle",
  "aliases",
  "aka",
  "title",
  "platform",
  "industry",
  "domain",
];

const EMBED_TEXT_CHARS = 2000;

export interface CardIndex {
  /** Поля фронтматтера: ключи в нижнем регистре, списки склеены пробелом. */
  fm: Record<string, string>;
  /** META_FIELDS одной строкой — то, что уезжает в meta-колонку и в эмбеддинг. */
  meta: string;
  body: string;
}

/**
 * Frontmatter карточки в плоский поисковый вид: список склеиваем пробелом (FTS всё равно
 * токенизирует), ключи приводим к нижнему регистру — регистр ключа не должен решать,
 * найдётся карточка или нет.
 */
export function cardIndex(text: string): CardIndex {
  const { fields, body } = parseFrontmatter(text);
  const fm: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields ?? {}))
    fm[key.toLowerCase()] = Array.isArray(value) ? value.join(" ") : value;
  return {
    fm,
    meta: META_FIELDS.map((key) => fm[key])
      .filter(Boolean)
      .join(" "),
    body,
  };
}

/** Имя карточки без расширения — заголовок для обеих половин поиска. */
export function cardTitle(path: string): string {
  return path.replace(/\.md$/, "").split(/[/\\]/).pop() || "";
}

/**
 * Текст карточки для dense-эмбеддинга: ровно те четыре колонки, что индексирует BM25
 * (title/meta/tags/body), в том же порядке и с тем же содержимым — иначе половины
 * поиска в режиме hybrid ранжируют разные карточки. Начало карточки уже несёт её
 * смысл, а провайдеры берут деньги за токены, поэтому хвост обрезаем.
 */
export function embedText(path: string, text: string): string {
  const { fm, meta, body } = cardIndex(text);
  return [cardTitle(path), meta, fm.tags, body]
    .filter(Boolean)
    .join(" ")
    .slice(0, EMBED_TEXT_CHARS);
}
