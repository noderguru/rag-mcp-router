import { test } from "node:test";
import assert from "node:assert/strict";
import { RagRetriever, type ToolHit } from "../src/retriever.js";
import { VectorStore } from "../src/index/store.js";
import { Bm25Index } from "../src/index/bm25.js";
import type { RouterConfig } from "../src/config.js";
import type { Embedder } from "../src/index/embed.js";

// RagRetriever takes its embedder/store/bm25 by constructor injection, so we can
// drive it deterministically with precomputed vectors — no model download.

const mkCatalog = (names: string[]): ToolHit[] =>
  names.map((n) => ({ server: "s", name: n, description: n, inputSchema: { type: "object", properties: {} } }));

const stubEmbedder = (vec: number[]): Embedder =>
  ({ embedQuery: async () => vec }) as unknown as Embedder;

const mkCfg = (over: Partial<RouterConfig["retrieval"]>): RouterConfig =>
  ({
    retrieval: {
      topK: 6,
      hybrid: true,
      alpha: 0.7,
      beta: 0.3,
      candidates: 20,
      rerank: false,
      rerankLambda: 0.7,
      pinned: [],
      ...over,
    },
  }) as unknown as RouterConfig;

test("ranks by cosine similarity when hybrid is off", async () => {
  const catalog = mkCatalog(["A", "B", "C"]);
  // cos to query [1,0,0]:  A=1, B=0, C=0.8
  const store = VectorStore.fromVectors([
    [1, 0, 0],
    [0, 1, 0],
    [0.8, 0.6, 0],
  ]);
  const r = new RagRetriever(catalog, store, stubEmbedder([1, 0, 0]), null, mkCfg({ hybrid: false }));
  const hits = await r.search("anything", 2);
  assert.deepEqual(hits.map((h) => h.name), ["A", "C"]);
});

test("hybrid blend lets BM25 break ties when the cosine signal is flat", async () => {
  const catalog = mkCatalog(["A", "B", "C"]);
  // Identical vectors → cosine is uninformative (normalizes to all-zeros), so the
  // lexical term decides the ranking.
  const store = VectorStore.fromVectors([
    [1, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
  ]);
  const bm25 = new Bm25Index(["alpha apple", "beta banana", "gamma grape"]);
  const r = new RagRetriever(catalog, store, stubEmbedder([1, 0, 0]), bm25, mkCfg({ hybrid: true }));
  const hits = await r.search("banana", 1);
  assert.equal(hits[0].name, "B");
});

test("MMR rerank favors a diverse item over a near-duplicate", async () => {
  const catalog = mkCatalog(["A", "B", "C"]);
  // A and B are near-duplicates; C is orthogonal (diverse).
  const store = VectorStore.fromVectors([
    [1, 0, 0],
    [0.99, 0.1411, 0],
    [0, 1, 0],
  ]);
  const cfg = mkCfg({ hybrid: false, rerank: true, rerankLambda: 0.2, candidates: 20 });
  const r = new RagRetriever(catalog, store, stubEmbedder([1, 0, 0]), null, cfg);
  const hits = await r.search("q", 2);
  assert.deepEqual(hits.map((h) => h.name), ["A", "C"]);
});

test("an empty query returns the first k tools", async () => {
  const catalog = mkCatalog(["A", "B", "C"]);
  const store = VectorStore.fromVectors([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  const r = new RagRetriever(catalog, store, stubEmbedder([1, 0, 0]), null, mkCfg({}));
  const hits = await r.search("   ", 2);
  assert.deepEqual(hits.map((h) => h.name), ["A", "B"]);
});
