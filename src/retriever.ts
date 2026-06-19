import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Conn } from "./downstream.js";

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

/**
 * MVP stub: naive keyword overlap scoring.
 *
 * TODO(rag): replace with local embeddings (fastembed / bge-small) + cosine,
 * optional BM25 hybrid + rerank. This stub exists only to prove the
 * client -> router -> downstream chain end to end. With an empty query it
 * returns everything, which is the pre-RAG "no filtering" baseline.
 */
export function search(catalog: ToolHit[], query: string, topK: number): ToolHit[] {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  if (terms.length === 0) return catalog.slice(0, topK);

  const scored = catalog.map((hit) => {
    const haystack = `${hit.server} ${hit.name} ${hit.description ?? ""}`.toLowerCase();
    const score = terms.reduce((s, term) => (haystack.includes(term) ? s + 1 : s), 0);
    return { hit, score };
  });

  const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const chosen = matched.length > 0 ? matched : scored; // fall back to all if no overlap
  return chosen.slice(0, topK).map((s) => s.hit);
}
