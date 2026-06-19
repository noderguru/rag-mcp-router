import type { Conn } from "./downstream.js";
import { reconnect } from "./downstream.js";

export interface DispatchResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function errorResult(text: string): DispatchResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Route a `call_tool` request to the right downstream server and proxy the
 *  result. If the target server is marked disconnected, one reconnect is
 *  attempted before failing with a clear "server is down" error. */
export async function dispatch(
  conns: Conn[],
  server: string,
  name: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const conn = conns.find((c) => c.name === server);
  if (!conn) return errorResult(`unknown server "${server}"`);

  if (conn.status === "disconnected") {
    try {
      await reconnect(conn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`server "${server}" is down (reconnect failed): ${message}`);
    }
  }

  try {
    const res = (await conn.client.callTool({ name, arguments: args })) as Record<string, unknown>;
    // Modern servers return `content`; normalize the legacy `{ toolResult }` shape too.
    if (Array.isArray(res.content)) return res as DispatchResult;
    return { ...res, content: [{ type: "text", text: JSON.stringify(res.toolResult ?? res) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`${server}.${name} failed: ${message}`);
  }
}
