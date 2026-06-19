import type { ToolHit } from "./retriever.js";

/**
 * Per-request + per-session metrics accounting (§5.1 formulas).
 *
 * All token counts use `js-tiktoken` (cl100k_base) locally — no network,
 * no API key.  The encoder is lazy-initialised and reused.
 */

let _encoder: import("js-tiktoken/lite").Tiktoken | null = null;

async function getEncoder(): Promise<import("js-tiktoken/lite").Tiktoken> {
  if (!_encoder) {
    const [{ Tiktoken }, cl100k] = await Promise.all([
      import("js-tiktoken/lite"),
      import("js-tiktoken/ranks/cl100k_base"),
    ]);
    // cl100k_base is ESM default-export.  Dynamic import with esModuleInterop
    // returns { default: TiktokenBPE } at runtime, but TS types it as the
    // module namespace.  Grab the default export explicitly.
    const bpe: { pat_str: string; special_tokens: Record<string, number>; bpe_ranks: string } =
      (cl100k as any).default ?? cl100k;
    _encoder = new Tiktoken(bpe);
  }
  return _encoder;
}

/** Count tokens in a UTF-8 string using cl100k_base (offline). */
export async function countTokens(text: string): Promise<number> {
  if (!text) return 0;
  const enc = await getEncoder();
  return enc.encode(text).length;
}

/**
 * Serialise a tool definition to the JSON shape the MCP client receives in
 * `tools/list`, then count its tokens.  This is `sch(t)` in §5.1.
 */
export async function toolSchemaTokens(hit: ToolHit): Promise<number> {
  const json = JSON.stringify({
    name: hit.name,
    description: hit.description ?? "",
    inputSchema: hit.inputSchema ?? { type: "object", properties: {} },
  });
  return countTokens(json);
}

/**
 * Serialise a facade-tool skeleton (name + desc + zod raw shape) to the same
 * `tools/list` JSON shape and count tokens.
 */
export async function facadeToolTokens(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): Promise<number> {
  // Convert the raw Zod shape into the JSON-Schema-compatible shape the MCP SDK
  // sends.  The SDK wraps each field in a JSON Schema subset; we approximate
  // faithfully enough for token counting.
  const props: Record<string, Record<string, unknown>> = {};
  for (const [key, zodType] of Object.entries(inputSchema)) {
    props[key] = zodToJsonSchemaFragment(zodType);
  }
  const required = Object.keys(props);
  const json = JSON.stringify({
    name,
    description,
    inputSchema: { type: "object", properties: props, required },
  });
  return countTokens(json);
}

/** Convert a Zod raw-shape value to its JSON-Schema fragment for counting. */
function zodToJsonSchemaFragment(z: unknown): Record<string, unknown> {
  const zodAny = z as { description?: string; _def?: { typeName?: string; values?: unknown[] } } | undefined;
  const desc = zodAny?.description;
  const base: Record<string, unknown> = {};
  if (desc) base.description = desc;

  if (zodAny?._def?.typeName === "ZodString") return { type: "string", ...base };
  if (zodAny?._def?.typeName === "ZodNumber") return { type: "number", ...base };
  if (zodAny?._def?.typeName === "ZodBoolean") return { type: "boolean", ...base };
  if (zodAny?._def?.typeName === "ZodRecord") return { type: "object", ...base };
  if (zodAny?._def?.typeName === "ZodEnum") return { type: "string", enum: zodAny._def.values, ...base };
  // fallback
  return { type: "string", ...base };
}

// ── Metrics accumulator ──────────────────────────────────────────────

export interface PerToolCall {
  server: string;
  name: string;
  calls: number;
}

export interface MetricsSnapshot {
  totalRequests: number;
  totalCalls: number;
  perToolCalls: PerToolCall[];

  baselinePerRequest: number;
  facadeTokens: number;

  sessionBaselineSum: number;
  sessionActualSum: number;
  sessionSavedSum: number;

  // surfaced-tool tracking per-request (for table)
  surfacedThisSession: string[]; // "server.name" keys
}

export class Metrics {
  totalRequests = 0;
  totalCalls = 0;
  perToolCalls = new Map<string, number>();

  readonly baselinePerRequest: number;
  readonly facadeTokens: number;

  sessionBaselineSum = 0;
  sessionActualSum = 0;
  sessionSavedSum = 0;

  /** Surfacings this session — for the dashboard "surfaced" column. */
  surfacedSet = new Set<string>();

  constructor(baselinePerRequest: number, facadeTokens: number) {
    this.baselinePerRequest = baselinePerRequest;
    this.facadeTokens = facadeTokens;
  }

  /** Call from `search_tools` handler. */
  async recordRequest(surfacedTools: ToolHit[]): Promise<void> {
    this.totalRequests++;

    const surfacedTokens =
      await Promise.all(surfacedTools.map((t) => toolSchemaTokens(t))).then((a) => a.reduce((s, x) => s + x, 0));

    const actual = this.facadeTokens + surfacedTokens;
    const saved = this.baselinePerRequest - actual;

    this.sessionBaselineSum += this.baselinePerRequest;
    this.sessionActualSum += actual;
    this.sessionSavedSum += saved;

    for (const t of surfacedTools) {
      this.surfacedSet.add(`${t.server}.${t.name}`);
    }
  }

  /** Call from `call_tool` handler. */
  recordCall(server: string, toolName: string): void {
    this.totalCalls++;
    const key = `${server}.${toolName}`;
    this.perToolCalls.set(key, (this.perToolCalls.get(key) ?? 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    const perToolCalls: PerToolCall[] = [];
    for (const [key, calls] of this.perToolCalls) {
      const dot = key.indexOf(".");
      perToolCalls.push({
        server: key.slice(0, dot),
        name: key.slice(dot + 1),
        calls,
      });
    }
    return {
      totalRequests: this.totalRequests,
      totalCalls: this.totalCalls,
      perToolCalls,
      baselinePerRequest: this.baselinePerRequest,
      facadeTokens: this.facadeTokens,
      sessionBaselineSum: this.sessionBaselineSum,
      sessionActualSum: this.sessionActualSum,
      sessionSavedSum: this.sessionSavedSum,
      surfacedThisSession: [...this.surfacedSet],
    };
  }
}
