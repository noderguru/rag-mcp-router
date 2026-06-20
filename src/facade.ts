import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RouterConfig } from "./config.js";
import type { Conn } from "./downstream.js";
import { dispatch } from "./dispatch.js";
import type { Retriever, ToolHit } from "./retriever.js";
import type { Metrics } from "./metrics.js";
import { registerPinned } from "./pinned.js";
import { ResultStore, applyResultPolicy } from "./results.js";

/**
 * The MCP server the *client* sees. It exposes only three facade tools instead
 * of the full (possibly 100+) downstream tool set, keeping the client's context
 * tiny. The agent calls `search_tools` to surface what it needs, then `call_tool`.
 *
 * If a `metrics` instance is provided, every `search_tools`/`call_tool` call is
 * recorded for per-request accounting (§5.1) and an additional `get_metrics`
 * facade tool is registered.
 */
export function createFacade(
  conns: Conn[],
  cfg: RouterConfig,
  retriever: Retriever,
  metrics?: Metrics,
  catalog?: ToolHit[],
  store?: ResultStore,
): McpServer {
  const server = new McpServer({ name: "rag-mcp-router", version: "0.1.0" });

  // Phase R — result store. Owned by the caller (index.ts) so it can be
  // disposed on shutdown; fall back to a local one for standalone use.
  const resultStore = store ?? new ResultStore(cfg.results, ".rag-mcp");

  server.registerTool(
    "search_tools",
    {
      title: "Find relevant tools",
      description:
        "Describe in natural language what you want to do. Returns only the " +
        "downstream tools relevant to that intent (with their input schemas), " +
        "so you don't have to load every tool into context.",
      inputSchema: {
        intent: z.string().describe("What you are trying to accomplish"),
        k: z.number().int().positive().optional().describe("Max tools to return"),
      },
    },
    async ({ intent, k }) => {
      const hits = await retriever.search(intent, k ?? cfg.retrieval.topK);
      if (metrics) await metrics.recordRequest(hits);
      return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.registerTool(
    "call_tool",
    {
      title: "Call a downstream tool",
      description:
        "Invoke a tool previously returned by search_tools. Pass the tool's " +
        "server, name, and arguments exactly as described by its input schema.",
      inputSchema: {
        server: z.string().describe("Origin server (from search_tools result)"),
        name: z.string().describe("Tool name"),
        arguments: z.record(z.unknown()).describe("Arguments object for the tool"),
      },
    },
    async ({ server: srv, name, arguments: args }) => {
      if (metrics) metrics.recordCall(srv, name);
      const res = await dispatch(conns, srv, name, args ?? {});
      return applyResultPolicy(res, { cfg: cfg.results, store: resultStore, metrics, server: srv, name });
    },
  );

  server.registerTool(
    "get_result",
    {
      title: "Read more of a deferred result",
      description:
        "Fetch the remainder of a large result that call_tool deferred. Pass the " +
        "resultId from the deferred result, plus an offset (and optional limit) to " +
        "page through the rest. Nothing is lost — the full payload is held server-side.",
      inputSchema: {
        resultId: z.string().describe("resultId from a deferred call_tool result"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)"),
        limit: z.number().int().positive().optional().describe("Max characters to return"),
      },
    },
    async ({ resultId, offset, limit }) => {
      const got = resultStore.get(resultId, offset ?? 0, limit ?? cfg.results.maxTokens * 4);
      if (!got) {
        return {
          isError: true,
          content: [{ type: "text", text: `result "${resultId}" is unknown or has expired` }],
        };
      }
      const { slice, ...meta } = got;
      return { content: [{ type: "text", text: slice }, { type: "text", text: JSON.stringify(meta) }] };
    },
  );

  server.registerTool(
    "list_servers",
    {
      title: "List connected MCP servers",
      description:
        "Show every configured downstream server, its connection status " +
        "(connected/disconnected), how many tools it exposes, and the last error if any.",
      inputSchema: {},
    },
    async () => {
      const summary = conns.map((c) => ({
        server: c.name,
        status: c.status,
        tools: c.tools.length,
        ...(c.lastError ? { lastError: c.lastError } : {}),
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
  );

  if (metrics) {
    server.registerTool(
      "get_metrics",
      {
        title: "Router session metrics",
        description:
          "Return live per-request accounting for the current session: " +
          "tokens saved, surfaced tools, per-tool call counts, baseline vs actual.",
        inputSchema: {},
      },
      async () => {
        const snap = metrics.snapshot();
        return { content: [{ type: "text", text: JSON.stringify(snap, null, 2) }] };
      },
    );
  }

  // Pinned tools — exposed directly so the client can call them without search_tools.
  if (catalog && cfg.retrieval.pinned.length) {
    registerPinned(server, catalog, cfg.retrieval.pinned, conns, metrics, resultStore, cfg.results);
  }

  return server;
}
