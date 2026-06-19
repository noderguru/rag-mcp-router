// Retrieval quality benchmark (Phase 5 acceptance).
//
// Compares semantic-only vs hybrid (BM25) vs hybrid+MMR on a fixed query set,
// reporting top-1 / top-3 accuracy and MRR. Runs fully offline once the
// embedding model is cached (.rag-mcp/models) — build first: `pnpm build`.
//
//   pnpm bench
//
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Embedder } from "../../dist/index/embed.js";
import { VectorStore } from "../../dist/index/store.js";
import { Bm25Index } from "../../dist/index/bm25.js";
import { RagRetriever, toDocument } from "../../dist/retriever.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(__dirname, "catalog.json"), "utf8"));
const queries = JSON.parse(readFileSync(join(__dirname, "queries.json"), "utf8"));

// Eval catalog entry → ToolHit shape (params[] → JSON-Schema properties).
const catalog = raw.map((t) => ({
  server: t.server,
  name: t.name,
  description: t.description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries((t.params ?? []).map((p) => [p, { type: "string" }])),
  },
}));
const key = (h) => `${h.server}.${h.name}`;

console.error(`[bench] embedding ${catalog.length} tools (cached model)...`);
const embedder = await Embedder.init("bge-small-en-v1.5", join(__dirname, "..", "..", ".rag-mcp", "models"));
const store = VectorStore.fromVectors(await embedder.embedDocuments(catalog.map(toDocument)));
const bm25 = new Bm25Index(catalog.map(toDocument));

const baseRetrieval = { topK: 6, alpha: 0.7, beta: 0.3, candidates: 8, rerankLambda: 0.7, pinned: [] };
const modes = {
  "semantic   ": { ...baseRetrieval, hybrid: false, rerank: false, bm25: null },
  "hybrid     ": { ...baseRetrieval, hybrid: true, rerank: false, bm25 },
  "hybrid+mmr ": { ...baseRetrieval, hybrid: true, rerank: true, bm25 },
};

async function evalMode(retrieval, bm) {
  const r = new RagRetriever(catalog, store, embedder, bm, { retrieval });
  let top1 = 0;
  let top3 = 0;
  let mrr = 0;
  const misses = [];
  for (const { query, expect } of queries) {
    const hits = await r.search(query, catalog.length);
    const rank = hits.findIndex((h) => key(h) === expect); // 0-based
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 3) top3++;
    if (rank >= 0) mrr += 1 / (rank + 1);
    if (rank !== 0) misses.push(`"${query}" → expected ${expect}, got #${rank + 1 || "∞"} (${hits[0] ? key(hits[0]) : "—"})`);
  }
  const n = queries.length;
  return { top1: top1 / n, top3: top3 / n, mrr: mrr / n, misses };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`\nRetrieval benchmark — ${queries.length} queries over ${catalog.length} tools\n`);
console.log("mode          top-1    top-3    MRR");
console.log("------------  -------  -------  -------");
const results = {};
for (const [label, m] of Object.entries(modes)) {
  const { bm25: bm, ...retrieval } = m;
  const res = await evalMode(retrieval, bm);
  results[label.trim()] = res;
  console.log(`${label}  ${pct(res.top1).padStart(7)}  ${pct(res.top3).padStart(7)}  ${res.mrr.toFixed(3).padStart(7)}`);
}

// Show what hybrid still gets wrong (useful for tuning / deciding on a reranker).
const hybridMisses = results["hybrid"].misses;
if (hybridMisses.length) {
  console.log(`\nhybrid misses (${hybridMisses.length}):`);
  for (const m of hybridMisses) console.log(`  - ${m}`);
} else {
  console.log("\nhybrid: no misses 🎉");
}
console.log();
