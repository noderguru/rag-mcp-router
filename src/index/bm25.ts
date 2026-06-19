/**
 * Minimal BM25 lexical index over the tool catalog, aligned positionally to the
 * vector store: `score(i)` is the BM25 relevance of catalog[i] to the query.
 *
 * BM25 complements semantic embeddings: embeddings match by *meaning*, BM25
 * matches exact rare terms (tool names, identifiers, jargon the embedding model
 * may not know). The hybrid retriever blends the two.
 *
 * Pure TypeScript, no dependencies. Standard Okapi BM25 with k1=1.5, b=0.75.
 */

const K1 = 1.5;
const B = 0.75;

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export class Bm25Index {
  /** Per-document term-frequency maps, aligned to the catalog. */
  private readonly tf: Map<string, number>[];
  /** Document lengths (token counts), aligned to the catalog. */
  private readonly len: number[];
  /** Inverse document frequency per term. */
  private readonly idf: Map<string, number>;
  private readonly avgdl: number;
  readonly size: number;

  constructor(docs: string[]) {
    this.size = docs.length;
    this.tf = [];
    this.len = [];
    const df = new Map<string, number>();

    for (const doc of docs) {
      const terms = tokenize(doc);
      this.len.push(terms.length);
      const counts = new Map<string, number>();
      for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
      this.tf.push(counts);
      for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    }

    const totalLen = this.len.reduce((a, b) => a + b, 0);
    this.avgdl = this.size > 0 ? totalLen / this.size : 0;

    // BM25 idf with the standard +1 inside the log to keep it non-negative.
    this.idf = new Map();
    for (const [term, n] of df) {
      this.idf.set(term, Math.log(1 + (this.size - n + 0.5) / (n + 0.5)));
    }
  }

  /** BM25 score for every document against `query` (index-aligned to the catalog). */
  scoreAll(query: string): number[] {
    const qTerms = [...new Set(tokenize(query))];
    const scores = new Array<number>(this.size).fill(0);
    if (this.avgdl === 0) return scores;

    for (let i = 0; i < this.size; i++) {
      const tf = this.tf[i];
      const dl = this.len[i];
      let s = 0;
      for (const term of qTerms) {
        const f = tf.get(term);
        if (!f) continue;
        const idf = this.idf.get(term) ?? 0;
        s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (dl / this.avgdl))));
      }
      scores[i] = s;
    }
    return scores;
  }
}
