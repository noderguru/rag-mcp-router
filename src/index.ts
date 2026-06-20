#!/usr/bin/env node
import { writeFileSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { connectAll } from "./downstream.js";
import { createFacade } from "./facade.js";
import { buildCatalog, buildRetriever } from "./retriever.js";
import { Metrics, countTokens, toolSchemaTokens, facadeToolTokens } from "./metrics.js";
import { generateReport } from "./report.js";
import { ResultStore } from "./results.js";
import type { ToolHit } from "./retriever.js";

/** Local runtime state (persisted index + cached embedding model). Gitignored. */
const STATE_DIR = ".rag-mcp";

function parseArgs(argv: string[]): { config: string } {
  const i = argv.indexOf("--config");
  const config = i >= 0 && argv[i + 1] ? argv[i + 1] : "rag-mcp.config.json";
  return { config };
}

const HELP = `rag-mcp-router — semantic tool selection for MCP

Usage:
  rag-mcp-router init                 Scaffold a starter rag-mcp.config.json
  rag-mcp-router --config <file>      Run the router (default: rag-mcp.config.json)
  rag-mcp-router --help               Show this help

Quick start:
  npx rag-mcp-router init             # then edit "mcpServers" in the new file
  npx rag-mcp-router --config rag-mcp.config.json
`;

/** `init` subcommand: copy the bundled example config into the cwd so a new
 *  user is one edit away from running. Never overwrites an existing config. */
function runInit(): void {
  const target = resolve("rag-mcp.config.json");
  if (existsSync(target)) {
    console.error(`[rag-mcp-router] ${target} already exists — not overwriting.`);
    console.error("[rag-mcp-router] edit it, then run: npx rag-mcp-router --config rag-mcp.config.json");
    return;
  }
  const distDir = dirname(fileURLToPath(import.meta.url));
  const example = join(distDir, "..", "rag-mcp.config.example.json");
  copyFileSync(example, target);
  console.error(`[rag-mcp-router] wrote starter config to ${target}`);
  console.error('[rag-mcp-router] next: edit the "mcpServers" block to point at your servers, then run:');
  console.error("[rag-mcp-router]   npx rag-mcp-router --config rag-mcp.config.json");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "init") return runInit();
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }

  const { config: configPath } = parseArgs(argv);

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

  // Phase R — result store, owned here so shutdown can dispose it.
  const resultStore = new ResultStore(cfg.results, STATE_DIR);
  const facade = createFacade(conns, cfg, retriever, metrics, catalog, resultStore);

  // ── graceful shutdown → report.html ─────────────────────────────────
  let shuttingDown = false;
  const onShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    resultStore.dispose();
    try {
      const reportPath = join(STATE_DIR, "report.html");
      // `dist/` is flat, `docs/` and `package.json` are at the repo root.
      const distDir = dirname(fileURLToPath(import.meta.url));
      const prototypePath = join(distDir, "..", "docs", "report-prototype.html");
      const html = generateReport({
        catalog,
        snapshot: metrics.snapshot(),
        config: cfg,
        version: readVersion(distDir),
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
  console.error(
    "[rag-mcp-router] facade ready on stdio (search_tools / call_tool / get_result / list_servers / get_metrics)",
  );
}

/** Read the package version from the bundled package.json (one level above
 *  the flat `dist/`). Falls back to "0.0.0" if it can't be read. */
function readVersion(distDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(distDir, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── token-counting helpers ────────────────────────────────────────────

async function sumSchemaTokens(catalog: ToolHit[]): Promise<number> {
  const counts = await Promise.all(catalog.map((t) => toolSchemaTokens(t)));
  return counts.reduce((a, b) => a + b, 0);
}

/** Token count of the facade-tool schemas as the client sees them in
 *  `tools/list`.  These few tools replace the full downstream catalog. */
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
      name: "get_result",
      desc: "Fetch the remainder of a large result that call_tool deferred. Pass the resultId from the deferred result, plus an offset (and optional limit) to page through the rest. Nothing is lost — the full payload is held server-side.",
      schema: {
        resultId: { description: "resultId from a deferred call_tool result", _def: { typeName: "ZodString" } },
        offset: { description: "Character offset to start from (default 0)", _def: { typeName: "ZodNumber" } },
        limit: { description: "Max characters to return", _def: { typeName: "ZodNumber" } },
      },
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
