import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** A single downstream MCP server entry — same shape as the standard
 *  `mcpServers` block in Claude/Cursor configs, so users migrate by pasting. */
export interface ServerSpec {
  /** stdio: executable to spawn */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Streamable HTTP: remote endpoint (mutually exclusive with command) */
  url?: string;
}

export interface RouterConfig {
  billing: {
    mode: "api" | "subscription";
    /** api mode */
    pricePerMTok?: number;
    /** subscription mode */
    client?: string;
    contextWindow?: number;
  };
  embedding: { backend: "local"; model: string };
  retrieval: { topK: number; hybrid: boolean };
  mcpServers: Record<string, ServerSpec>;
}

const DEFAULTS: Pick<RouterConfig, "billing" | "embedding" | "retrieval"> = {
  billing: { mode: "subscription", client: "generic", contextWindow: 200000 },
  embedding: { backend: "local", model: "bge-small-en-v1.5" },
  retrieval: { topK: 6, hybrid: true },
};

export function loadConfig(path: string): RouterConfig {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as Partial<RouterConfig>;
  if (!raw.mcpServers || Object.keys(raw.mcpServers).length === 0) {
    throw new Error(`config ${path}: "mcpServers" is empty — nothing to route to`);
  }
  return {
    billing: { ...DEFAULTS.billing, ...raw.billing },
    embedding: { ...DEFAULTS.embedding, ...raw.embedding },
    retrieval: { ...DEFAULTS.retrieval, ...raw.retrieval },
    mcpServers: raw.mcpServers,
  };
}
