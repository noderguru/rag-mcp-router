import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RouterConfig } from "./config.js";
import type { Conn } from "./downstream.js";
import { Embedder } from "./index/embed.js";
import { VectorStore } from "./index/store.js";
import { Bm25Index } from "./index/bm25.js";
import { mmr } from "./index/rerank.js";

export interface ToolHit {
  server: string;
  name: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
}

/** Flat catalog of every downstream tool, tagged with its origin server. */
export function buildCatalog(conns: Conn[]): ToolHit[] {
  return conns.flatMap((c) =>
    c.tools.map((t) => ({
      server: c.name,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  );
}

/** Retrieves the tools most relevant to a natural-language intent. */
export interface Retriever {
  search(query: string, k: number): Promise<ToolHit[]>;
}

/**
 * The text we embed for each tool. Includes the server/name (so distinctive
 * identifiers contribute) plus the description and parameter names, which carry
 * most of the semantic signal about what the tool does.
 */
export function toDocument(hit: ToolHit): string {
  const props = hit.inputSchema?.properties;
  const params = props ? Object.keys(props) : [];
  const paramPart = params.length ? ` | params: ${params.join(", ")}` : "";
  return `${hit.server}.${hit.name}: ${hit.description ?? ""}${paramPart}`;
}

/** Fingerprint of the embedded corpus — model + every document. */
export function catalogHash(model: string, docs: string[]): string {
  return createHash("sha256").update(model).update("\n").update(docs.join("\n")).digest("hex");
}

/**
 * Build the active retriever. Tries the semantic (local-embeddings) backend
 * first: embeds the catalog once, persisting the index so an unchanged tool set
 * reloads without re-embedding. If the embedder can't initialize (offline first
 * run, missing model, etc.) it degrades to keyword search so the router still
 * works — just less smart — with a warning on stderr.
 */
export async function buildRetriever(
  catalog: ToolHit[],
  cfg: RouterConfig,
  stateDir: string,
): Promise<Retriever> {
  const docs = catalog.map(toDocument);
  try {
    const embedder = await Embedder.init(cfg.embedding.model, join(stateDir, "models"));
    const hash = catalogHash(cfg.embedding.model, docs);
    const indexPath = join(stateDir, "index.json");

    let store = VectorStore.load(indexPath, hash);
    if (store) {
      console.error(
        `[retriever] loaded persisted index: ${store.vectors.length} tool(s), dim ${store.dimension}`,
      );
    } else {
      console.error(`[retriever] embedding ${docs.length} tool(s) with ${cfg.embedding.model}...`);
      store = VectorStore.fromVectors(await embedder.embedDocuments(docs));
      store.persist(indexPath, cfg.embedding.model, hash);
      console.error(`[retriever] index built and persisted to ${indexPath}`);
    }
    const bm25 = cfg.retrieval.hybrid ? new Bm25Index(docs) : null;
    console.error(
      `[retriever] mode: ${cfg.retrieval.hybrid ? `hybrid (α=${cfg.retrieval.alpha}/β=${cfg.retrieval.beta})` : "semantic"}` +
        `${cfg.retrieval.rerank ? `, MMR rerank (λ=${cfg.retrieval.rerankLambda})` : ""}`,
    );
    return new RagRetriever(catalog, store, embedder, bm25, cfg);
  } catch (err) {
    console.error("[retriever] semantic backend unavailable, using keyword fallback:", err);
    return new KeywordRetriever(catalog);
  }
}

/** Min-max normalize a score array to [0,1]; flat arrays map to all-zeros. */
function normalize(scores: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const range = max - min;
  if (range <= 0) return scores.map(() => 0);
  return scores.map((s) => (s - min) / range);
}

/** Descending argsort: returns catalog indices ordered by score, best first. */
function argsortDesc(scores: number[]): number[] {
  return scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.index);
}

/**
 * Local-embeddings retrieval with an optional lexical (BM25) blend and optional
 * MMR rerank:
 *   1. score every tool by cosine (and, in hybrid mode, BM25), blend α·cos+β·bm25
 *   2. take the top-`candidates` pool
 *   3. either return the top-k, or MMR-rerank the pool for relevance+diversity
 */
export class RagRetriever implements Retriever {
  constructor(
    private readonly catalog: ToolHit[],
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly bm25: Bm25Index | null,
    private readonly cfg: RouterConfig,
  ) {}

  async search(query: string, k: number): Promise<ToolHit[]> {
    if (!query.trim()) return this.catalog.slice(0, k);
    const { alpha, beta, rerank, rerankLambda, candidates } = this.cfg.retrieval;

    const queryVec = await this.embedder.embedQuery(query);
    const cos = this.store.scoreAll(queryVec);

    let combined: number[];
    if (this.bm25) {
      const lex = this.bm25.scoreAll(query);
      const nc = normalize(cos);
      const nl = normalize(lex);
      combined = cos.map((_, i) => alpha * nc[i] + beta * nl[i]);
    } else {
      combined = cos;
    }

    const ranked = argsortDesc(combined);
    if (!rerank) return ranked.slice(0, k).map((i) => this.catalog[i]);

    const pool = ranked.slice(0, Math.max(k, candidates));
    return mmr(queryVec, pool, this.store.vectors, rerankLambda, k).map((i) => this.catalog[i]);
  }
}

/**
 * Fallback: naive keyword-overlap scoring. Same behavior as the original MVP
 * stub — used only when the embedding backend is unavailable.
 */
export class KeywordRetriever implements Retriever {
  constructor(private readonly catalog: ToolHit[]) {}

  async search(query: string, k: number): Promise<ToolHit[]> {
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
    if (terms.length === 0) return this.catalog.slice(0, k);

    const scored = this.catalog.map((hit) => {
      const haystack = `${hit.server} ${hit.name} ${hit.description ?? ""}`.toLowerCase();
      const score = terms.reduce((s, term) => (haystack.includes(term) ? s + 1 : s), 0);
      return { hit, score };
    });

    const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    const chosen = matched.length > 0 ? matched : scored; // fall back to all if no overlap
    return chosen.slice(0, k).map((s) => s.hit);
  }
}
