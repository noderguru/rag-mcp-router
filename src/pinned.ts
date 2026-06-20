import { z, type ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Conn } from "./downstream.js";
import { dispatch } from "./dispatch.js";
import type { ToolHit } from "./retriever.js";
import type { Metrics } from "./metrics.js";
import { applyResultPolicy, type ResultStore } from "./results.js";
import type { ResultsConfig } from "./config.js";

/** A JSON Schema property as it appears in a tool's inputSchema. */
interface JsonSchemaProp {
  type?: string;
  description?: string;
  enum?: unknown[];
}

/** Convert one JSON Schema property to its closest Zod type (shallow). */
function propToZod(prop: JsonSchemaProp): ZodTypeAny {
  let zt: ZodTypeAny;
  if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string")) {
    zt = z.enum(prop.enum as [string, ...string[]]);
  } else {
    switch (prop.type) {
      case "string":
        zt = z.string();
        break;
      case "number":
      case "integer":
        zt = z.number();
        break;
      case "boolean":
        zt = z.boolean();
        break;
      case "array":
        zt = z.array(z.unknown());
        break;
      case "object":
        zt = z.record(z.unknown());
        break;
      default:
        zt = z.unknown();
    }
  }
  return prop.description ? zt.describe(prop.description) : zt;
}

/**
 * Build a Zod raw shape from a downstream tool's JSON Schema inputSchema so it
 * can be re-registered as a first-class facade tool. Shallow by design (top-level
 * properties only) — deep schemas degrade to `z.unknown()`, which still proxies
 * correctly since args are forwarded verbatim.
 */
export function jsonSchemaToZodShape(inputSchema: ToolHit["inputSchema"]): Record<string, ZodTypeAny> {
  const props = (inputSchema?.properties ?? {}) as Record<string, JsonSchemaProp>;
  const required = new Set((inputSchema as { required?: string[] })?.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const zt = propToZod(prop);
    shape[key] = required.has(key) ? zt : zt.optional();
  }
  return shape;
}

/** Sanitize "server.name" into a valid MCP tool name (`[A-Za-z0-9_-]`). */
export function pinnedToolName(server: string, name: string): string {
  return `${server}.${name}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Register the configured pinned tools directly on the facade so the client can
 * call them without going through search_tools. Each is proxied to its
 * downstream server exactly like call_tool. Returns the catalog entries that
 * were actually pinned (for metrics accounting); unknown keys are warned and
 * skipped.
 */
export function registerPinned(
  server: McpServer,
  catalog: ToolHit[],
  pinned: string[],
  conns: Conn[],
  metrics?: Metrics,
  store?: ResultStore,
  resultsCfg?: ResultsConfig,
): ToolHit[] {
  const registered: ToolHit[] = [];
  for (const key of pinned) {
    const hit = catalog.find((t) => `${t.server}.${t.name}` === key);
    if (!hit) {
      console.error(`[pinned] "${key}" not found in any connected server — skipping`);
      continue;
    }
    server.registerTool(
      pinnedToolName(hit.server, hit.name),
      {
        title: `${hit.name} (pinned)`,
        description: `Pinned tool from "${hit.server}". ${hit.description ?? ""}`.trim(),
        inputSchema: jsonSchemaToZodShape(hit.inputSchema),
      },
      async (args: Record<string, unknown>) => {
        if (metrics) metrics.recordCall(hit.server, hit.name);
        const res = await dispatch(conns, hit.server, hit.name, args ?? {});
        // Pinned calls go through the same Phase R result policy as call_tool.
        if (store && resultsCfg) {
          return applyResultPolicy(res, { cfg: resultsCfg, store, metrics, server: hit.server, name: hit.name });
        }
        return res;
      },
    );
    registered.push(hit);
  }
  if (registered.length) {
    console.error(`[pinned] exposed ${registered.length} tool(s) directly: ${registered.map((h) => `${h.server}.${h.name}`).join(", ")}`);
  }
  return registered;
}
