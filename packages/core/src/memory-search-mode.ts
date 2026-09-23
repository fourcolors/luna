/**
 * The retrieval modes a memory search can run in. One list, shared by the
 * backend contract (@luna/memory), the router, the SQLite backend, and the
 * RetrievalCall observability event + its runtime Schema, which used to
 * hand-copy the union in five places.
 *
 *   vec              pure cosine ranking
 *   hybrid           vec + exact-PHRASE BM25, equal-weight RRF (production
 *                    default; the phrase arm rarely matches a natural question)
 *   bm25             pure FTS5 BM25 over the query's words, no embedding
 *   hybrid-terms     vec + bag-of-words BM25, equal-weight RRF
 *   hybrid-weighted  vec + stopword-filtered bag-of-words BM25 (+ optional
 *                    expansion terms as their own arm), weighted RRF
 */
export const MEMORY_SEARCH_MODES = [
  "vec",
  "hybrid",
  "bm25",
  "hybrid-terms",
  "hybrid-weighted",
] as const

export type MemorySearchMode = (typeof MEMORY_SEARCH_MODES)[number]
