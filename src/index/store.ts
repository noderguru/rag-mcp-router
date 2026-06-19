import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const INDEX_VERSION = 1;

interface IndexFile {
  version: number;
  model: string;
  dimension: number;
  /** Fingerprint of the embedded catalog; mismatch ⇒ re-embed. */
  hash: string;
  vectors: number[][];
}

export interface ScoredIndex {
  index: number;
  score: number;
}

/**
 * In-memory vector index aligned positionally to the tool catalog: `vectors[i]`
 * is the embedding of `catalog[i]`. Vectors are L2-normalized by the embedder,
 * so cosine similarity is a plain dot product. Persisted to a single JSON file
 * so a restart with an unchanged tool set skips re-embedding.
 */
export class VectorStore {
  constructor(
    readonly vectors: number[][],
    readonly dimension: number,
  ) {}

  static fromVectors(vectors: number[][]): VectorStore {
    return new VectorStore(vectors, vectors[0]?.length ?? 0);
  }

  /** Top-k catalog indices by descending similarity to `query`. */
  search(query: number[], k: number): ScoredIndex[] {
    const scored = this.vectors.map((v, index) => ({ index, score: dot(query, v) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, k));
  }

  /** Cosine similarity of `query` to every vector (index-aligned to the catalog). */
  scoreAll(query: number[]): number[] {
    return this.vectors.map((v) => dot(query, v));
  }

  persist(path: string, model: string, hash: string): void {
    const file: IndexFile = {
      version: INDEX_VERSION,
      model,
      dimension: this.dimension,
      hash,
      vectors: this.vectors,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file));
  }

  /** Load a persisted index, or null if missing/corrupt/stale (hash mismatch). */
  static load(path: string, expectedHash: string): VectorStore | null {
    if (!existsSync(path)) return null;
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as IndexFile;
      if (file.version !== INDEX_VERSION || file.hash !== expectedHash) return null;
      if (!Array.isArray(file.vectors)) return null;
      return new VectorStore(file.vectors, file.dimension);
    } catch {
      return null;
    }
  }
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}
