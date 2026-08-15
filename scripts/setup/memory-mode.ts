export type MemorySearchMode = "hybrid" | "grep";

/**
 * Keep memory search on free BM25 unless hybrid was requested and has a usable source.
 * An empty key must fail safe instead of persisting a configuration that `iva doctor` rejects.
 */
export function resolveMemorySearchMode(
  wantsHybrid: boolean,
  env: Readonly<Record<string, string | undefined>>,
): MemorySearchMode {
  const hasEmbeddingSource = [
    env.JINA_API_KEY,
    env.DEEPINFRA_API_KEY,
    env.MEMORY_EMBED_URL,
  ].some((value) => Boolean(value?.trim()));

  return wantsHybrid && hasEmbeddingSource ? "hybrid" : "grep";
}
