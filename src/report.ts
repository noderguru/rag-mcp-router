import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolHit } from "./retriever.js";
import type { MetricsSnapshot } from "./metrics.js";
import type { RouterConfig } from "./config.js";

/**
 * Generate a self-contained `report.html` from live metrics.
 *
 * Strategy: read the prototype from `docs/report-prototype.html`, find the
 * mock-data block (delimited by marker comments), and replace it with live
 * JSON.  The prototype's render functions (JS/CSS) are untouched — only the
 * data globals change.
 */

const MOCK_START = "/* ===== mock data — stand-in for metrics.ts ===== */";
const MOCK_END = "function compute() {";

export interface ReportInput {
  /** Every downstream tool in the catalog. */
  catalog: ToolHit[];
  /** Live metrics snapshot. */
  snapshot: MetricsSnapshot;
  /** Active config (for mode, window, price). */
  config: RouterConfig;
  /** Router version string. */
  version: string;
  /** Path to the prototype HTML file. */
  prototypePath: string;
}

export function generateReport(input: ReportInput): string {
  const html = readFileSync(input.prototypePath, "utf8");

  const mockStart = html.indexOf(MOCK_START);
  const mockEnd = html.indexOf(MOCK_END, mockStart);
  if (mockStart < 0 || mockEnd < 0) {
    throw new Error("prototype HTML: mock-data markers not found");
  }

  const before = html.slice(0, mockStart);
  const after = html.slice(mockEnd);

  const liveBlock = buildLiveBlock(input);

  return before + liveBlock + "\n" + after;
}

// ── live-data block ──────────────────────────────────────────────────

function buildLiveBlock(input: ReportInput): string {
  const { catalog, snapshot, config } = input;

  // Facade tokens — measured at init
  const FACADE_TOKENS = snapshot.facadeTokens;

  // Build TOOLS array: same shape as prototype's mapped tuples
  const surfacedSet = new Set(snapshot.surfacedThisSession);
  const callMap = new Map(snapshot.perToolCalls.map((c) => [`${c.server}.${c.name}`, c.calls]));

  const toolsJson = JSON.stringify(
    catalog.map((t) => {
      const key = `${t.server}.${t.name}`;
      const props = t.inputSchema?.properties;
      const params = props ? Object.keys(props) : [];
      return [
        t.server,
        t.name,
        estimateTokens(t),
        surfacedSet.has(key),
        callMap.get(key) ?? 0,
        params,
      ];
    }),
  );

  // Build state
  const state = {
    mode: config.billing.mode,
    pricePerMTok: config.billing.pricePerMTok ?? 3.0,
    windowK: (config.billing.contextWindow ?? 200000) / 1000,
    requests: snapshot.totalRequests || 1,
    // Phase R — result-side savings, separate from the definition-side numbers.
    resultTokensDeferred: snapshot.resultTokensDeferred,
    sort: { key: "tokens", dir: "desc" },
    filter: "",
    surfacedOnly: false,
    expanded: [],
    firstPaint: true,
  };

  // Escape JSON payloads for embedding in <script> — prevent `</` from
  // closing the script tag prematurely.
  const safe = (s: string) => s.replace(/<\//g, "<\\/");

  return [
    MOCK_START,
    `const FACADE_TOKENS = ${FACADE_TOKENS};`,
    `const TOOLS = ${safe(toolsJson)}.map(t => ({ server:t[0], name:t[1], tokens:t[2], surfaced:t[3], calls:t[4], params:t[5] }));`,
    "",
    `const state = ${safe(JSON.stringify(state))};`,
    `state.expanded = new Set(state.expanded);`,
    "",
  ].join("\n");
}

/** Quick token estimate without async — used for per-tool tokens in table.
 *  Real accounting uses async `toolSchemaTokens()` from metrics.ts. */
function estimateTokens(t: ToolHit): number {
  const json = JSON.stringify({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? {},
  });
  // ~4 chars/token for English-heavy JSON — close enough for table display
  return Math.max(1, Math.round(json.length / 3.8));
}
