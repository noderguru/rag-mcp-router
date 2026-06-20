import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateReport } from "../src/report.js";
import type { ToolHit } from "../src/retriever.js";
import type { RouterConfig } from "../src/config.js";
import type { MetricsSnapshot } from "../src/metrics.js";

const prototypePath = resolve(fileURLToPath(import.meta.url), "../../docs/report-prototype.html");

const catalog: ToolHit[] = [
  {
    server: "github",
    name: "create_issue",
    description: "open an issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
];

const snapshot: MetricsSnapshot = {
  totalRequests: 3,
  totalCalls: 1,
  perToolCalls: [{ server: "github", name: "create_issue", calls: 1 }],
  baselinePerRequest: 1000,
  facadeTokens: 420,
  sessionBaselineSum: 3000,
  sessionActualSum: 1500,
  sessionSavedSum: 1500,
  resultTokensDeferred: 250,
  surfacedThisSession: ["github.create_issue"],
};

const config = {
  billing: { mode: "api", pricePerMTok: 5, client: "cursor", contextWindow: 200000 },
  embedding: { backend: "local", model: "bge-small-en-v1.5" },
  retrieval: { topK: 6, hybrid: true, alpha: 0.7, beta: 0.3, candidates: 20, rerank: false, rerankLambda: 0.7, pinned: [] },
  results: { maxTokens: 2000, strategy: "spill", store: "disk", ttlSeconds: 900, dropFields: {} },
  mcpServers: {},
} as unknown as RouterConfig;

test("generateReport injects live data in place of the mock block", () => {
  const html = generateReport({ catalog, snapshot, config, version: "9.9.9", prototypePath });
  assert.match(html, /const FACADE_TOKENS = 420;/);
  assert.match(html, /create_issue/);
  assert.match(html, /"mode":"api"/);
  assert.match(html, /"resultTokensDeferred":250/);
});

test("generateReport stamps the live version into the footer", () => {
  const html = generateReport({ catalog, snapshot, config, version: "9.9.9", prototypePath });
  assert.match(html, /rag-mcp-router v9\.9\.9/);
  // The prototype's placeholder version must not leak into the generated report.
  assert.doesNotMatch(html, /rag-mcp-router v0\.\d+\.\d+/);
});

test("generateReport throws a clear error when the markers are missing", () => {
  assert.throws(
    () =>
      generateReport({
        catalog,
        snapshot,
        config,
        version: "1.0.0",
        prototypePath: fileURLToPath(import.meta.url), // this test file has no markers
      }),
    /markers/,
  );
});
