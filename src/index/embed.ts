import { mkdirSync } from "node:fs";
import { EmbeddingModel, FlagEmbedding } from "fastembed";

/**
 * Map our friendly config model names to fastembed's enum. The local-first
 * default is bge-small-en-v1.5 (384-dim) — small, fast, no API key, downloaded
 * once and cached on disk. Unknown names fall back to the default.
 */
const MODELS: Record<string, Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>> = {
  "bge-small-en-v1.5": EmbeddingModel.BGESmallENV15,
  "bge-small-en": EmbeddingModel.BGESmallEN,
  "bge-base-en-v1.5": EmbeddingModel.BGEBaseENV15,
  "bge-small-zh-v1.5": EmbeddingModel.BGESmallZH,
  "all-minilm-l6-v2": EmbeddingModel.AllMiniLML6V2,
};

/**
 * Thin wrapper over fastembed's FlagEmbedding. Documents and queries are
 * embedded with the library's asymmetric convention (`passage:` / `query:`
 * prefixes) and L2-normalized, so cosine similarity reduces to a dot product
 * in the store. All download/progress output goes to stderr (the `progress`
 * package defaults to stderr), keeping stdout clean for the MCP channel.
 */
export class Embedder {
  private constructor(
    private readonly fe: FlagEmbedding,
    /** Embedding vector length for the loaded model (e.g. 384 for bge-small). */
    readonly dimension: number,
  ) {}

  static async init(modelName: string, cacheDir: string): Promise<Embedder> {
    const model = MODELS[modelName] ?? EmbeddingModel.BGESmallENV15;
    // fastembed's own mkdir is non-recursive, so ensure the cache path exists first.
    mkdirSync(cacheDir, { recursive: true });
    const fe = await FlagEmbedding.init({ model, cacheDir, showDownloadProgress: true });
    const dimension = fe.listSupportedModels().find((m) => m.model === model)?.dim ?? 384;
    return new Embedder(fe, dimension);
  }

  /** Embed indexable tool documents (drained from fastembed's batch generator). */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for await (const batch of this.fe.passageEmbed(texts, 64)) {
      // fastembed yields Float32Array rows; convert to plain arrays so they
      // survive JSON persistence (a Float32Array serializes to an object).
      for (const v of batch) vectors.push(Array.from(v));
    }
    return vectors;
  }

  /** Embed a single search query. */
  async embedQuery(text: string): Promise<number[]> {
    return Array.from(await this.fe.queryEmbed(text));
  }
}
