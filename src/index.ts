#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { connectAll } from "./downstream.js";
import { createFacade } from "./facade.js";
import { buildCatalog, buildRetriever } from "./retriever.js";
import { Metrics, countTokens, toolSchemaTokens, facadeToolTokens } from "./metrics.js";
import { generateReport } from "./report.js";
import type { ToolHit } from "./retriever.js";

/** Local runtime state (persisted index + cached embedding model). Gitignored. */
const STATE_DIR = ".rag-mcp";

function parseArgs(argv: string[]): { config: string } {
  const i = argv.indexOf("--config");
  const config = i >= 0 && argv[i + 1] ? argv[i + 1] : "rag-mcp.config.json";
  return { config };
}

async function main() {
  const { config: configPath } = parseArgs(process.argv.slice(2));

  // All logging goes to stderr — stdout is reserved for the MCP protocol stream.
  console.error(`[rag-mcp-router] loading config from ${configPath}`);
  const cfg = loadConfig(configPath);

  console.error(`[rag-mcp-router] connecting to ${Object.keys(cfg.mcpServers).length} downstream server(s)...`);
  const conns = await connectAll(cfg);
  const toolCount = conns.reduce((n, c) => n + c.tools.length, 0);
  console.error(`[rag-mcp-router] connected ${conns.length} server(s), ${toolCount} tool(s) discovered`);

  const catalog = buildCatalog(conns);
  const retriever = await buildRetriever(catalog, cfg, STATE_DIR);

  // ── metrics initialisation ──────────────────────────────────────────
  const baselinePerRequest = await sumSchemaTokens(catalog);
  // Pinned tools are always visible to the client, so they count as constant
  // overhead alongside the facade tools (not as per-request surfaced tools).
  const pinnedHits = catalog.filter((t) => cfg.retrieval.pinned.includes(`${t.server}.${t.name}`));
  const pinnedTokens = await sumSchemaTokens(pinnedHits);
  const facadeTokens = (await facadeOverhead()) + pinnedTokens;
  const metrics = new Metrics(baselinePerRequest, facadeTokens);
  console.error(
    `[rag-mcp-router] metrics: baseline ${baselinePerRequest} tok, facade overhead ${facadeTokens} tok` +
      (pinnedHits.length ? ` (incl. ${pinnedHits.length} pinned)` : ""),
  );

  const facade = createFacade(conns, cfg, retriever, metrics, catalog);

  // ── graceful shutdown → report.html ─────────────────────────────────
  let shuttingDown = false;
  const onShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      const reportPath = join(STATE_DIR, "report.html");
      // `dist/` is flat, `docs/` is at the repo root.
      const distDir = dirname(fileURLToPath(import.meta.url));
      const prototypePath = join(distDir, "..", "docs", "report-prototype.html");
      const html = generateReport({
        catalog,
        snapshot: metrics.snapshot(),
        config: cfg,
        version: "0.1.0",
        prototypePath,
      });
      writeFileSync(reportPath, html, "utf8");
      console.error(`[rag-mcp-router] report written to ${reportPath}`);
    } catch (err) {
      console.error("[rag-mcp-router] failed to write report:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);

  await facade.connect(new StdioServerTransport());
  console.error("[rag-mcp-router] facade ready on stdio (search_tools / call_tool / list_servers / get_metrics)");
}

// ── token-counting helpers ────────────────────────────────────────────

async function sumSchemaTokens(catalog: ToolHit[]): Promise<number> {
  const counts = await Promise.all(catalog.map((t) => toolSchemaTokens(t)));
  return counts.reduce((a, b) => a + b, 0);
}

/** Token count of the 4 facade-tool schemas as the client sees them in
 *  `tools/list`.  These 4 tools replace the full downstream catalog. */
async function facadeOverhead(): Promise<number> {
  const tools = [
    {
      name: "search_tools",
      desc: "Describe in natural language what you want to do. Returns only the downstream tools relevant to that intent (with their input schemas), so you don't have to load every tool into context.",
      schema: {
        intent: { description: "What you are trying to accomplish", _def: { typeName: "ZodString" } },
        k: { description: "Max tools to return", _def: { typeName: "ZodNumber" } },
      },
    },
    {
      name: "call_tool",
      desc: "Invoke a tool previously returned by search_tools. Pass the tool's server, name, and arguments exactly as described by its input schema.",
      schema: {
        server: { description: "Origin server (from search_tools result)", _def: { typeName: "ZodString" } },
        name: { description: "Tool name", _def: { typeName: "ZodString" } },
        arguments: { description: "Arguments object for the tool", _def: { typeName: "ZodRecord" } },
      },
    },
    {
      name: "list_servers",
      desc: "Show every connected downstream server and how many tools it exposes.",
      schema: {},
    },
    {
      name: "get_metrics",
      desc: "Return live per-request accounting for the current session: tokens saved, surfaced tools, per-tool call counts, baseline vs actual.",
      schema: {},
    },
  ];

  const counts = await Promise.all(tools.map((t) => facadeToolTokens(t.name, t.desc, t.schema)));
  return counts.reduce((a, b) => a + b, 0);
}

main().catch((err) => {
  console.error("[rag-mcp-router] fatal:", err);
  process.exit(1);
});
