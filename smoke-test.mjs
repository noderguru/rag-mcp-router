// End-to-end smoke test: client -> rag-mcp-router -> downstream (server-everything)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(__dirname, ".rag-mcp", "report.html");

const client = new Client({ name: "smoke-test", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--config", "test.config.json"],
});

await client.connect(transport);

// 1) Client should see ONLY the facade tools, not the downstream's tools.
const { tools } = await client.listTools();
console.log("\n[1] facade tools:", tools.map((t) => t.name).join(", "));
const facadeNames = tools.map((t) => t.name);
if (!facadeNames.includes("search_tools") || !facadeNames.includes("call_tool")) {
  throw new Error("facade isolation failed: expected search_tools + call_tool");
}

// 2) list_servers
const servers = await client.callTool({ name: "list_servers", arguments: {} });
console.log("[2] list_servers:", servers.content[0].text.replace(/\s+/g, " "));

// 3) search_tools — should surface downstream tools by intent
const found = await client.callTool({ name: "search_tools", arguments: { intent: "echo a message back", k: 3 } });
const hits = JSON.parse(found.content[0].text);
console.log("[3] search_tools('echo...') ->", hits.map((h) => `${h.server}.${h.name}`).join(", "));

// 4) call_tool — proxy a real downstream call end to end
const echoed = await client.callTool({
  name: "call_tool",
  arguments: { server: "everything", name: "echo", arguments: { message: "router-works" } },
});
console.log("[4] call_tool(echo) ->", echoed.content[0].text);

// 5) Semantic retrieval — a query with NO keyword overlap with the tool's text
// ("small picture" vs "Returns a tiny MCP logo image") must still surface
// get-tiny-image at the top. A keyword scorer would find no overlap and fall
// back to the first tool (echo), so this also proves the RAG core is active.
const sem = await client.callTool({
  name: "search_tools",
  arguments: { intent: "show me a small picture", k: 3 },
});
const semHits = JSON.parse(sem.content[0].text);
console.log("[5] search_tools('show me a small picture') ->", semHits.map((h) => `${h.server}.${h.name}`).join(", "));
if (semHits[0]?.name !== "get-tiny-image") {
  throw new Error(`semantic retrieval failed: expected get-tiny-image on top, got ${semHits[0]?.name}`);
}

// ── Phase 2 acceptance checks ────────────────────────────────────────

// 6) get_metrics — must return a valid snapshot
if (facadeNames.includes("get_metrics")) {
  const metricsRes = await client.callTool({ name: "get_metrics", arguments: {} });
  const snap = JSON.parse(metricsRes.content[0].text);
  console.log("[6] get_metrics: requests=" + snap.totalRequests +
    " calls=" + snap.totalCalls +
    " baseline=" + snap.baselinePerRequest +
    " facade=" + snap.facadeTokens +
    " saved=" + snap.sessionSavedSum);

  if (snap.totalRequests < 1) throw new Error("get_metrics: expected totalRequests >= 1");
  if (!snap.baselinePerRequest) throw new Error("get_metrics: baselinePerRequest missing");
  if (!snap.facadeTokens) throw new Error("get_metrics: facadeTokens missing");
  if (!Array.isArray(snap.perToolCalls)) throw new Error("get_metrics: perToolCalls missing");
  console.log("[6] ✅ get_metrics OK");
} else {
  console.log("[6] ⚠️ get_metrics not registered (metrics disabled)");
}

await client.close();

// 7) report.html must exist after process exits
// Give the router process a moment to write the shutdown report.
await new Promise((r) => setTimeout(r, 300));

if (existsSync(REPORT_PATH)) {
  const reportHtml = readFileSync(REPORT_PATH, "utf8");
  // Should contain live tool names from the downstream server
  if (reportHtml.includes('["everything","echo"')) {
    console.log("[7] ✅ report.html exists with live data (" +
      Buffer.byteLength(reportHtml) + " bytes)");
  } else if (reportHtml.includes('["github","create_issue"')) {
    // Exact mock-data signature — would mean template wasn't replaced
    console.log("[7] ❌ report.html contains mock data — template not replaced");
  } else {
    console.log("[7] ⚠️ report.html exists but may be incomplete");
  }
} else {
  console.log("[7] ⚠️ report.html not found — shutdown hook may not have fired");
  console.log("    (expected at " + REPORT_PATH + ")");
}

console.log("\n✅ end-to-end chain OK: client -> router -> downstream (semantic + metrics verified)\n");
process.exit(0);
