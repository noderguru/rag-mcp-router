import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/** A single downstream MCP server entry — same shape as the standard
 *  `mcpServers` block in Claude/Cursor configs, so users migrate by pasting.
 *  Exactly one of `command` (stdio) or `url` (Streamable HTTP) must be set. */
const ServerSpecSchema = z
  .object({
    /** stdio: executable to spawn */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    /** Streamable HTTP: remote endpoint (mutually exclusive with command) */
    url: z.string().url("must be a valid URL").optional(),
  })
  .strict()
  .refine((s) => Boolean(s.command) !== Boolean(s.url), {
    message: 'set exactly one of "command" (stdio) or "url" (HTTP)',
  });

const BillingSchema = z
  .object({
    mode: z.enum(["api", "subscription"]).default("subscription"),
    /** api mode: USD price per million tokens */
    pricePerMTok: z.number().positive().optional(),
    /** subscription mode */
    client: z.string().default("generic"),
    contextWindow: z.number().int().positive().default(200000),
  })
  .strict()
  .default({});

const EmbeddingSchema = z
  .object({
    backend: z.literal("local").default("local"),
    model: z.string().default("bge-small-en-v1.5"),
  })
  .strict()
  .default({});

const RetrievalSchema = z
  .object({
    topK: z.number().int().positive().default(6),
    /** Blend lexical BM25 with semantic cosine (Phase 5). */
    hybrid: z.boolean().default(true),
    /** Weight of the semantic (cosine) score in the hybrid blend. */
    alpha: z.number().min(0).default(0.7),
    /** Weight of the lexical (BM25) score in the hybrid blend. */
    beta: z.number().min(0).default(0.3),
    /** Size of the first-stage candidate pool fed to the reranker. */
    candidates: z.number().int().positive().default(20),
    /** Enable MMR (relevance-vs-diversity) reranking of the candidate pool. */
    rerank: z.boolean().default(false),
    /** MMR tradeoff: 1.0 = pure relevance, 0.0 = pure diversity. */
    rerankLambda: z.number().min(0).max(1).default(0.7),
    /** Tools to expose directly to the client ("server.name"), callable
     *  without search_tools. Keep this short — pinned tools always cost context. */
    pinned: z.array(z.string()).default([]),
  })
  .strict()
  .default({});

/** Phase R — runtime result optimization. Trims large tool *results* before
 *  they enter the model context. Default posture is lossless: oversized results
 *  are held in a store and replaced with a preview + a handle to read the rest
 *  via the `get_result` facade tool. */
const ResultsSchema = z
  .object({
    /** Results at or under this token count pass through untouched (zero overhead). */
    maxTokens: z.number().int().positive().default(2000),
    /** "passthrough" = never trim; "spill" = store full + return preview (lossless);
     *  "truncate" = cut to budget with a marker (lossy, opt-in). */
    strategy: z.enum(["passthrough", "spill", "truncate"]).default("spill"),
    /** Where deferred results live: in-memory map or under `.rag-mcp/results/`. */
    store: z.enum(["memory", "disk"]).default("disk"),
    /** Deferred results older than this are swept. */
    ttlSeconds: z.number().int().positive().default(900),
    /** Opt-in per-tool field projection: drop named noisy fields from JSON results.
     *  Keyed by tool `name` or `server.name`. Empty by default. */
    dropFields: z.record(z.array(z.string())).default({}),
  })
  .strict()
  .default({});

const ConfigSchema = z
  .object({
    billing: BillingSchema,
    embedding: EmbeddingSchema,
    retrieval: RetrievalSchema,
    results: ResultsSchema,
    mcpServers: z
      .record(ServerSpecSchema)
      .refine((m) => Object.keys(m).length > 0, {
        message: 'is empty — add at least one server to route to',
      }),
  })
  .strict();

export type ServerSpec = z.infer<typeof ServerSpecSchema>;
export type RouterConfig = z.infer<typeof ConfigSchema>;
export type ResultsConfig = RouterConfig["results"];

/** Turn a ZodError into a compact, path-prefixed, multi-line message. */
function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `  • ${path}: ${issue.message}`;
    })
    .join("\n");
}

/** Load, parse, and validate the router config. Throws with a readable,
 *  field-by-field message on any schema or JSON error. */
export function loadConfig(path: string): RouterConfig {
  const resolved = resolve(path);

  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`config ${path}: cannot read file — ${reason}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`config ${path}: invalid JSON — ${reason}`);
  }

  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`config ${path}: validation failed —\n${formatZodError(result.error)}`);
  }
  return result.data;
}
