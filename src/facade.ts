import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RouterConfig } from "./config.js";
import type { Conn } from "./downstream.js";
import { dispatch } from "./dispatch.js";
import type { Retriever } from "./retriever.js";

/**
 * The MCP server the *client* sees. It exposes only three facade tools instead
 * of the full (possibly 100+) downstream tool set, keeping the client's context
 * tiny. The agent calls `search_tools` to surface what it needs, then `call_tool`.
 */
export function createFacade(conns: Conn[], cfg: RouterConfig, retriever: Retriever): McpServer {
  const server = new McpServer({ name: "rag-mcp-router", version: "0.1.0" });

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
      return dispatch(conns, srv, name, args ?? {});
    },
  );

  server.registerTool(
    "list_servers",
    {
      title: "List connected MCP servers",
      description: "Show every connected downstream server and how many tools it exposes.",
      inputSchema: {},
    },
    async () => {
      const summary = conns.map((c) => ({ server: c.name, tools: c.tools.length }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
  );

  return server;
}
