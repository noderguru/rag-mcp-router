import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RouterConfig, ServerSpec } from "./config.js";

/** A live connection to one downstream MCP server plus its discovered tools. */
export interface Conn {
  name: string;
  client: Client;
  tools: Tool[];
}

async function connectOne(name: string, spec: ServerSpec): Promise<Conn> {
  const client = new Client({ name: "rag-mcp-router", version: "0.1.0" });

  const transport = spec.url
    ? new StreamableHTTPClientTransport(new URL(spec.url))
    : new StdioClientTransport({
        command: spec.command!,
        args: spec.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
      });

  await client.connect(transport);

  // Tool lists are paginated by cursor — drain all pages.
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.listTools(cursor ? { cursor } : {});
    tools.push(...res.tools);
    cursor = res.nextCursor;
  } while (cursor);

  return { name, client, tools };
}

/** Connect to every configured downstream server in parallel.
 *  Failures are isolated: one bad server does not sink the others. */
export async function connectAll(cfg: RouterConfig): Promise<Conn[]> {
  const results = await Promise.allSettled(
    Object.entries(cfg.mcpServers).map(([name, spec]) => connectOne(name, spec)),
  );

  const conns: Conn[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      conns.push(r.value);
    } else {
      // stderr only — stdout is the MCP channel and must stay clean.
      console.error(`[downstream] failed to connect: ${r.reason}`);
    }
  }
  if (conns.length === 0) throw new Error("no downstream MCP servers connected");
  return conns;
}
