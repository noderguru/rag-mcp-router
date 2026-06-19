/**
 * Maximal Marginal Relevance (MMR) reranking over the candidate pool.
 *
 * First-stage retrieval (semantic / hybrid) ranks tools purely by relevance,
 * which can fill the top-k with near-duplicate tools. MMR re-selects the k
 * results to balance relevance to the query against diversity from the items
 * already picked, so the agent sees complementary tools rather than redundant
 * ones. Operates on the embeddings we already computed — no extra model.
 *
 *   λ = 1.0 → pure relevance (same as no rerank)
 *   λ = 0.0 → pure diversity
 *
 * A neural cross-encoder reranker is a possible future backend; this is the
 * dependency-free default.
 */

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Reorder `candidates` (catalog indices, relevance-ranked best-first) into the
 * top-`k` MMR selection. `vectors` are the L2-normalized catalog embeddings;
 * `queryVec` is the normalized query embedding.
 */
export function mmr(
  queryVec: number[],
  candidates: number[],
  vectors: number[][],
  lambda: number,
  k: number,
): number[] {
  const pool = [...candidates];
  const selected: number[] = [];
  const limit = Math.min(k, pool.length);

  // Precompute relevance (query similarity) for each candidate.
  const rel = new Map<number, number>();
  for (const idx of pool) rel.set(idx, dot(queryVec, vectors[idx]));

  while (selected.length < limit && pool.length > 0) {
    let bestIdx = -1;
    let bestPos = -1;
    let bestScore = -Infinity;

    for (let p = 0; p < pool.length; p++) {
      const idx = pool[p];
      let maxSimToSelected = 0;
      for (const s of selected) {
        const sim = dot(vectors[idx], vectors[s]);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const score = lambda * (rel.get(idx) ?? 0) - (1 - lambda) * maxSimToSelected;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
        bestPos = p;
      }
    }

    selected.push(bestIdx);
    pool.splice(bestPos, 1);
  }
  return selected;
}
