import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RouterConfig, ServerSpec } from "./config.js";

export type ConnStatus = "connected" | "disconnected";

/** A live (or once-live) connection to one downstream MCP server plus its
 *  discovered tools. Keeps the originating `spec` so it can be reconnected. */
export interface Conn {
  name: string;
  spec: ServerSpec;
  client: Client;
  tools: Tool[];
  status: ConnStatus;
  /** Last connection/dispatch error, surfaced in `list_servers`. */
  lastError?: string;
}

function buildTransport(spec: ServerSpec) {
  return spec.url
    ? new StreamableHTTPClientTransport(new URL(spec.url))
    : new StdioClientTransport({
        command: spec.command!,
        args: spec.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
      });
}

/** Open a client, connect, and drain the (paginated) tool list. */
async function openClient(spec: ServerSpec): Promise<{ client: Client; tools: Tool[] }> {
  const client = new Client({ name: "rag-mcp-router", version: "0.1.0" });
  await client.connect(buildTransport(spec));

  // Tool lists are paginated by cursor — drain all pages.
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.listTools(cursor ? { cursor } : {});
    tools.push(...res.tools);
    cursor = res.nextCursor;
  } while (cursor);

  return { client, tools };
}

async function connectOne(name: string, spec: ServerSpec): Promise<Conn> {
  const { client, tools } = await openClient(spec);
  const conn: Conn = { name, spec, client, tools, status: "connected" };
  // Mark the connection dead if the transport drops, so the next dispatch reconnects.
  client.onclose = () => {
    conn.status = "disconnected";
  };
  return conn;
}

/** A configured-but-unreachable server. Kept in the catalog so `list_servers`
 *  can report it as dead; `dispatch` will attempt to reconnect on first use. */
function deadConn(name: string, spec: ServerSpec, error: string): Conn {
  return {
    name,
    spec,
    client: new Client({ name: "rag-mcp-router", version: "0.1.0" }),
    tools: [],
    status: "disconnected",
    lastError: error,
  };
}

/** Re-open a downstream connection in place, refreshing its client + tools.
 *  Throws (and leaves the conn marked disconnected) if it still can't connect. */
export async function reconnect(conn: Conn): Promise<void> {
  try {
    const { client, tools } = await openClient(conn.spec);
    conn.client = client;
    conn.tools = tools;
    conn.status = "connected";
    conn.lastError = undefined;
    client.onclose = () => {
      conn.status = "disconnected";
    };
  } catch (err) {
    conn.status = "disconnected";
    conn.lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/** Connect to every configured downstream server in parallel. Failures are
 *  isolated: a server that won't connect is kept as a dead placeholder (visible
 *  in `list_servers`, reconnectable on demand) rather than dropped. */
export async function connectAll(cfg: RouterConfig): Promise<Conn[]> {
  const entries = Object.entries(cfg.mcpServers);
  const settled = await Promise.allSettled(entries.map(([name, spec]) => connectOne(name, spec)));

  const conns: Conn[] = settled.map((r, i) => {
    const [name, spec] = entries[i];
    if (r.status === "fulfilled") return r.value;
    const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
    // stderr only — stdout is the MCP channel and must stay clean.
    console.error(`[downstream] failed to connect "${name}": ${message}`);
    return deadConn(name, spec, message);
  });

  if (conns.every((c) => c.status === "disconnected")) {
    throw new Error("no downstream MCP servers connected");
  }
  return conns;
}
