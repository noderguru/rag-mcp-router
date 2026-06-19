import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RouterConfig } from "./config.js";
import type { Conn } from "./downstream.js";
import { Embedder } from "./index/embed.js";
import { VectorStore } from "./index/store.js";

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
function toDocument(hit: ToolHit): string {
  const props = hit.inputSchema?.properties;
  const params = props ? Object.keys(props) : [];
  const paramPart = params.length ? ` | params: ${params.join(", ")}` : "";
  return `${hit.server}.${hit.name}: ${hit.description ?? ""}${paramPart}`;
}

/** Fingerprint of the embedded corpus — model + every document. */
function catalogHash(model: string, docs: string[]): string {
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
    return new SemanticRetriever(catalog, store, embedder);
  } catch (err) {
    console.error("[retriever] semantic backend unavailable, using keyword fallback:", err);
    return new KeywordRetriever(catalog);
  }
}

/** Local-embeddings retrieval: embed query → cosine top-k over the index. */
class SemanticRetriever implements Retriever {
  constructor(
    private readonly catalog: ToolHit[],
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  async search(query: string, k: number): Promise<ToolHit[]> {
    if (!query.trim()) return this.catalog.slice(0, k);
    const queryVec = await this.embedder.embedQuery(query);
    return this.store.search(queryVec, k).map((r) => this.catalog[r.index]);
  }
}

/**
 * Fallback: naive keyword-overlap scoring. Same behavior as the original MVP
 * stub — used only when the embedding backend is unavailable.
 */
class KeywordRetriever implements Retriever {
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
