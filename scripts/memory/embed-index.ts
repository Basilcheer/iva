// Строит сайдкар-индекс эмбеддингов для hybrid-поиска: vault/.index/embeddings.json.
// Запускается вручную или ночным doctor.ts (только при MEMORY_SEARCH_MODE=hybrid).
//   node --env-file=.env scripts/memory/embed-index.ts
//
// Эмбеддит карточки/саммари через один внешний ключ (Jina/DeepInfra, см. agent/lib/embeddings.ts),
// пишет { model, vectors: { "<vault-rel-path>": number[] } }. Локальной модели/RAM нет.
// Индекс — производный, не в vault (markdown остаётся портируемым); потерялся — пересобери.
import {
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  embedTexts,
  embeddingProviderName,
  hasEmbeddingKey,
} from "../../agent/lib/embeddings.ts";

const VAULT = process.env.ASSISTANT_VAULT_DIR || "vault";
const SCOPE = ["cards", "summaries", "weekly", "monthly", "yearly"];
const IGNORE = new Set([
  ".git",
  "node_modules",
  ".graph",
  ".index",
  ".trash",
  "attachments",
]);

if (!hasEmbeddingKey()) {
  console.error(
    "embed-index: no JINA_API_KEY / DEEPINFRA_API_KEY — nothing to build (base mode uses BM25).",
  );
  process.exit(0);
}

function walk(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORE.has(e.name)) walk(full, out);
    } else if (e.name.endsWith(".md")) out.push(full);
  }
}

// Текст для эмбеддинга: заголовок + ключевые поля фронтматтера + начало тела (обрезаем).
function embedText(file: string): string {
  const raw = readFileSync(file, "utf8");
  let fmMeta = "";
  let body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = raw.slice(3, end);
      body = raw.slice(end + 4);
      for (const line of fm.split("\n")) {
        const m =
          /^(name|company|role|description|tags|handle|aliases|title):\s*(.+)$/.exec(
            line,
          );
        if (m) fmMeta += m[2] + " ";
      }
    }
  }
  const title = file.replace(/\.md$/, "").split(sep).pop() || "";
  return `${title} ${fmMeta} ${body}`.slice(0, 2000);
}

const files: string[] = [];
for (const d of SCOPE) {
  const abs = join(VAULT, d);
  try {
    if (statSync(abs).isDirectory()) walk(abs, files);
  } catch {
    /* нет директории */
  }
}

if (files.length === 0) {
  console.error("embed-index: no cards/summaries found — nothing to embed.");
  process.exit(0);
}

console.log(
  `embed-index: ${files.length} docs via ${embeddingProviderName()} …`,
);
const texts = files.map(embedText);
const vectors = await embedTexts(texts);

const index: {
  model: string;
  count: number;
  vectors: Record<string, number[]>;
} = {
  model: embeddingProviderName(),
  count: files.length,
  vectors: {},
};
files.forEach((f, i) => {
  if (vectors[i])
    index.vectors[relative(VAULT, f).split(sep).join("/")] = vectors[i];
});

mkdirSync(join(VAULT, ".index"), { recursive: true });
writeFileSync(
  join(VAULT, ".index", "embeddings.json"),
  JSON.stringify(index),
  "utf8",
);
console.log(
  `embed-index: wrote ${Object.keys(index.vectors).length} vectors → ${VAULT}/.index/embeddings.json`,
);
process.exit(0);
