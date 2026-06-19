#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { connectAll } from "./downstream.js";
import { createFacade } from "./facade.js";
import { buildCatalog, buildRetriever } from "./retriever.js";

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

  const facade = createFacade(conns, cfg, retriever);
  await facade.connect(new StdioServerTransport());
  console.error("[rag-mcp-router] facade ready on stdio (search_tools / call_tool / list_servers)");
}

main().catch((err) => {
  console.error("[rag-mcp-router] fatal:", err);
  process.exit(1);
});
