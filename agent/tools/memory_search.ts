import { defineTool } from "eve/tools";
import { z } from "zod";
import { readdir, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { embedTexts, cosine, hasEmbeddingKey } from "../lib/embeddings.js";
import { cardIndex, cardTitle } from "../lib/card-index.js";

// node:sqlite — встроенный модуль (Node 24+). В ESM нет глобального require, поэтому
// поднимаем его через createRequire; грузим лениво внутри bm25Search (с fallback, если нет).
const nodeRequire = createRequire(import.meta.url);

// Поиск по долговременной памяти (vault). Заменяет «сырой grep» из MAP-протокола:
// BM25-ранжирование через встроенный node:sqlite FTS5 (ноль внешних зависимостей, ноль
// нативной сборки) + бесплатный graph-реранк по готовому vault/.graph/vault-graph.json
// (его пишет autograph graph.py каждую ночь). Деградирует мягко: любой сбой движка →
// подстрочный fallback, ход НЕ падает.

const VAULT = () => process.env.ASSISTANT_VAULT_DIR || "vault";
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".cache",
  ".graph",
  ".index",
  ".trash",
]);
const DEFAULT_DIRS = ["cards", "summaries", "weekly", "monthly", "yearly"];
const MAX_SNIPPET = 240;

interface Doc {
  // КОНТРАКТ ПУТЕЙ: vault-relative, без ведущего "./" — ровно в таком виде путь уезжает
  // в hits[].file. read_file умеет резолвить такие пути от ASSISTANT_VAULT_DIR (см.
  // agent/tools/read_file.ts); менять формат в одиночку нельзя — иначе ENOENT у модели.
  path: string;
  title: string;
  meta: string; // ключевые скалярные поля фронтматтера (name/company/role/description/aliases…)
  body: string;
  tags: string;
  status: string;
  confidence: string;
  source: string;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
}

export async function loadDocs(scopeDirs: string[]): Promise<Doc[]> {
  const vault = VAULT();
  const files: string[] = [];
  for (const d of scopeDirs) {
    const abs = join(vault, d);
    try {
      if ((await stat(abs)).isDirectory()) await walk(abs, files);
    } catch {
      /* нет такой директории — пропускаем */
    }
  }
  const docs: Doc[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const { fm, meta, body } = cardIndex(text);
    const rel = relative(vault, file).split(sep).join("/");
    docs.push({
      path: rel,
      title: cardTitle(rel) || rel,
      meta,
      body: body.slice(0, 8000),
      tags: fm.tags || "",
      status: (fm.status || "").toLowerCase(),
      confidence: (fm.confidence || "").toUpperCase(),
      source: fm.source || "",
    });
  }
  return docs;
}

// Токены запроса — язык-АГНОСТИЧНО: любые буквенно-цифровые последовательности (Unicode),
// уникальные. Никаких стоп-слов и порогов длины: значимость слова определяется его редкостью
// в самом вольте (IDF, см. searchMemory), а не языковыми списками. Частое слово на любом языке
// (the / с / 的 / und) само получит нулевой вес.
function contentTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
}

// Токены → FTS5 MATCH: каждый как префиксный терм (морфология универсальна — суффиксы русского,
// финского, турецкого; для изолирующих языков префикс = точное совпадение), объединяем через OR.
// Шум от коротких общих префиксов гасит IDF-взвешенный coverage, а не порог длины.
function toFtsQuery(tokens: string[]): string {
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

type GraphNodes = Record<string, { incoming?: string[]; outgoing?: string[] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isGraphNodes(value: unknown): value is GraphNodes {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (node) =>
      isRecord(node) &&
      (node.incoming === undefined || isStringArray(node.incoming)) &&
      (node.outgoing === undefined || isStringArray(node.outgoing)),
  );
}

function isVectorIndex(value: unknown): value is Record<string, number[]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (vector) =>
      Array.isArray(vector) &&
      vector.every(
        (component) =>
          typeof component === "number" && Number.isFinite(component),
      ),
  );
}

// Читаем ночной adjacency-граф (autograph graph.py). ASSISTANT_GRAPH_PATH — override для тестов.
function loadGraph(): GraphNodes {
  const path =
    process.env.ASSISTANT_GRAPH_PATH ||
    join(VAULT(), ".graph", "vault-graph.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return {};
    return isGraphNodes(parsed.nodes) ? parsed.nodes : {};
  } catch {
    return {};
  }
}

// Link-distance (node_distance-реранк): min число хопов от каждого узла до ближайшего якоря.
// Якоря — топ-BM25-хиты (сущности, о которых запрос). BFS по обе стороны рёбер, кап maxHops.
function bfsDistances(
  graph: GraphNodes,
  anchors: string[],
  maxHops: number,
): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier: string[] = [];
  for (const a of anchors) {
    if (graph[a]) {
      dist.set(a, 0);
      frontier.push(a);
    }
  }
  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      const n = graph[node];
      if (!n) continue;
      for (const nb of [...(n.outgoing ?? []), ...(n.incoming ?? [])]) {
        if (!dist.has(nb)) {
          dist.set(nb, hop);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

// --- Плагин: dense-слой + RRF (только MEMORY_SEARCH_MODE=hybrid) --------------------------

// Персистентный индекс эмбеддингов (сайдкар vault/.index/embeddings.json), строит embed-index.ts.
function loadEmbedIndex(): Record<string, number[]> | null {
  try {
    const raw = readFileSync(
      join(VAULT(), ".index", "embeddings.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return isVectorIndex(parsed.vectors) ? parsed.vectors : null;
  } catch {
    return null;
  }
}

// Dense-ранжирование: эмбеддинг ЗАПРОСА (1 вызов) + косинус к закэшированным векторам карточек.
async function denseRanked(
  query: string,
  docs: Doc[],
  limit: number,
): Promise<string[] | null> {
  const index = loadEmbedIndex();
  if (!index) return null;
  const [qvec] = await embedTexts([query]);
  if (!qvec) return null;
  const scored: Array<{ path: string; s: number }> = [];
  for (const doc of docs) {
    const v = index[doc.path];
    if (v) scored.push({ path: doc.path, s: cosine(qvec, v) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.path);
}

// RRF: сливаем несколько ранжированных списков по 1/(K+rank), игнорируя сырые скоры
// (BM25 unbounded, косинус [-1,1] — взвешивать нельзя, RRF снимает проблему).
function rrfFuse(lists: string[][], limit: number, K = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((path, i) =>
      score.set(path, (score.get(path) ?? 0) + 1 / (K + i)),
    );
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((e) => e[0]);
}

function snippet(body: string, tokens: string[]): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - 60);
  return body
    .slice(start, start + MAX_SNIPPET)
    .replace(/\s+/g, " ")
    .trim();
}

interface Hit {
  file: string;
  score: number;
  status: string;
  confidence: string;
  snippet: string;
}

// Возвращаем ПУТИ в порядке релевантности (лучший первым). Абсолютный bm25-скор для
// маленьких похожих карточек микроскопичен и нестабилен → дальше ранжируем по рангу (RRF-style),
// а не по сырому скору. Это же готовит слияние с dense-списком в плагине (RRF).

// BM25 через node:sqlite FTS5. Бросает — вызывающий ловит и уходит в fallback.
function bm25Search(docs: Doc[], ftsQuery: string, limit: number): string[] {
  // node:sqlite встроен в Node 24+, грузится без флага (проверено). createRequire — т.к. ESM.
  const { DatabaseSync } = nodeRequire(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE VIRTUAL TABLE d USING fts5(path UNINDEXED, title, meta, tags, body)",
    );
    const ins = db.prepare(
      "INSERT INTO d(path, title, meta, tags, body) VALUES (?, ?, ?, ?, ?)",
    );
    for (const doc of docs)
      ins.run(doc.path, doc.title, doc.meta, doc.tags, doc.body);
    // Веса колонок: title/meta важнее tags важнее body (bm25 меньше = релевантнее → ORDER BY asc).
    const rows = db
      .prepare(
        "SELECT path FROM d WHERE d MATCH ? ORDER BY bm25(d, 5.0, 5.0, 2.0, 1.0) LIMIT ?",
      )
      .all(ftsQuery, limit * 4) as Array<{ path: string }>;
    return rows.map((r) => r.path);
  } finally {
    db.close();
  }
}

// Fallback без sqlite: частота токенов, порядок по убыванию (грубо, но ход не падает).
function naiveSearch(docs: Doc[], tokens: string[]): string[] {
  const scored: Array<{ path: string; s: number }> = [];
  for (const doc of docs) {
    const hay = (
      doc.title +
      " " +
      doc.meta +
      " " +
      doc.tags +
      " " +
      doc.body
    ).toLowerCase();
    let s = 0;
    for (const t of tokens) {
      let idx = hay.indexOf(t);
      while (idx !== -1) {
        s += doc.title.toLowerCase().includes(t) ? 3 : 1;
        idx = hay.indexOf(t, idx + t.length);
      }
    }
    if (s > 0) scored.push({ path: doc.path, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.path);
}

export async function searchMemory({
  query,
  limit,
  scope,
}: {
  query: string;
  limit?: number;
  scope?: string[];
}): Promise<{ count: number; engine?: string; hits: Hit[]; note?: string }> {
  {
    const topN = limit ?? 12;
    const tokens = contentTokens(query);
    const docs = await loadDocs(scope && scope.length ? scope : DEFAULT_DIRS);
    if (docs.length === 0)
      return { count: 0, hits: [] as Hit[], note: "vault пуст или недоступен" };

    // BM25 (FTS5) → пути в порядке релевантности, с мягкой деградацией в наивный поиск.
    let ranked: string[];
    let engine = "bm25";
    try {
      const ftsQuery = toFtsQuery(tokens);
      ranked = ftsQuery ? bm25Search(docs, ftsQuery, topN) : [];
      if (ranked.length === 0) {
        ranked = naiveSearch(docs, tokens);
        engine = "naive-empty-bm25";
      }
    } catch {
      ranked = naiveSearch(docs, tokens);
      engine = "naive-fallback";
    }

    // Плагин: hybrid = BM25 ⊕ dense через RRF. Только при MEMORY_SEARCH_MODE=hybrid и наличии
    // ключа/индекса. Любой сбой (нет ключа/индекса, сеть) → тихо остаёмся на чистом BM25.
    if (process.env.MEMORY_SEARCH_MODE === "hybrid" && hasEmbeddingKey()) {
      try {
        const dense = await denseRanked(query, docs, topN * 4);
        if (dense && dense.length) {
          ranked = rrfFuse([ranked, dense], topN * 4);
          engine = "hybrid-rrf";
        }
      } catch {
        /* fallback на BM25 — engine остаётся как есть */
      }
    }

    // Ранговый скор (RRF-style, K=60): стабилен независимо от абсолютной величины bm25 и
    // готов к слиянию с dense-списком в плагине.
    const K = 60;
    const baseScore = new Map<string, number>();
    ranked.forEach((path, i) => baseScore.set(path, 1 / (K + i)));

    // Link-distance реранк: якоря = топ-3 BM25-хита; BFS даёт близость каждой карточки к теме.
    const graph = loadGraph();
    const anchors = ranked.slice(0, 3).map((p) => p.replace(/\.md$/, ""));
    const dist = bfsDistances(graph, anchors, 2);

    // Graph-recall: сильные соседи якорей (1 хоп), которых лексика не подняла — добавляем с
    // маленьким базовым скором, чтобы граф давал recall, а не только реранкил.
    const NEIGHBOR_BASE = 1 / (K + ranked.length + 5);
    for (const [noext, d] of dist) {
      if (d === 1 && !baseScore.has(noext + ".md"))
        baseScore.set(noext + ".md", NEIGHBOR_BASE);
    }

    // Язык-агностичное взвешивание: вес термина = его IDF в самом вольте (частое слово на ЛЮБОМ
    // языке — the/с/的/und — редкое → большое). Считаем haystack по каждой карточке один раз.
    const hayByPath = new Map<string, string>();
    for (const dd of docs)
      hayByPath.set(
        dd.path,
        (
          dd.title +
          " " +
          dd.meta +
          " " +
          dd.tags +
          " " +
          dd.body
        ).toLowerCase(),
      );
    const idf = new Map<string, number>();
    for (const t of tokens) {
      let dfc = 0;
      for (const h of hayByPath.values()) if (h.includes(t)) dfc++;
      idf.set(t, Math.log((docs.length + 1) / (dfc + 1)) + 1); // сглажённый, >0; редкий термин → вес↑
    }
    const idfTotal = tokens.reduce((s, t) => s + (idf.get(t) ?? 0), 0) || 1;

    // Coverage: доля ВЕСА (не количества) терминов запроса, покрытых карточкой. Документ, совпавший
    // лишь по одному общему токену («rush»→«Rushana»), покрывает малый вес → уступает тому, кто
    // покрыл редкие, различающие термины. Работает на любом языке без списков — вес даёт корпус.
    function coverage(path: string): number {
      if (tokens.length === 0) return 1;
      const hay = hayByPath.get(path) || "";
      let s = 0;
      for (const t of tokens) if (hay.includes(t)) s += idf.get(t) ?? 0;
      return s / idfTotal;
    }

    const STALE = new Set([
      "superseded",
      "archived",
      "cancelled",
      "inactive",
      "reverted",
    ]);
    const byPath = new Map(docs.map((d) => [d.path, d]));
    const scored: Hit[] = [];
    for (const [path, s0] of baseScore) {
      const doc = byPath.get(path);
      if (!doc) continue;
      const noext = path.replace(/\.md$/, "");
      const d = dist.get(noext);
      // Близость к якорю: 0 хопов ×1.5, 1 хоп ×1.3, 2 хопа ×1.15, недостижим ×1.
      const proximity =
        d === undefined ? 1 : d === 0 ? 1.5 : d === 1 ? 1.3 : 1.15;
      const incoming = graph[noext]?.incoming?.length ?? 0;
      // Coverage — сильный множитель (0.3..1.3): покрыл весь смысл запроса → буст, один из многих → штраф.
      const cov = 0.3 + coverage(doc.path);
      let score = s0 * cov * proximity * (1 + Math.min(incoming, 10) * 0.03);
      if (STALE.has(doc.status)) score *= 0.3; // пессимизируем устаревшее/неактивное (findable, но ниже)
      scored.push({
        file: doc.path,
        score: Number(score.toFixed(6)),
        status: doc.status,
        confidence: doc.confidence,
        snippet: snippet(doc.body, tokens),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return { count: scored.length, engine, hits: scored.slice(0, topN) };
  }
}

export default defineTool({
  description:
    "Поиск по долговременной памяти (vault: карточки и саммари). BM25-ранжирование + graph-реранк. " +
    "Используй ПЕРВЫМ на вопросы «что я знаю про X», «как звали…», «когда мы решили…» — вместо ручного " +
    "grep. Возвращает топ-совпадения { file, score, status, confidence, snippet }; затем открывай " +
    "1–3 лучших через read_file. status: superseded и confidence: INFERRED — читай осторожно (см. MAP).",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("Запрос в свободной форме (слова/имена/темы)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Сколько хитов вернуть (по умолчанию 8)"),
    scope: z
      .array(z.string())
      .optional()
      .describe(
        "Поддиректории vault для поиска (по умолчанию cards+summaries+weekly/monthly/yearly)",
      ),
  }),
  execute: searchMemory,
});
