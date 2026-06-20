import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ResultsConfig } from "./config.js";
import type { DispatchResult } from "./dispatch.js";
import { countTokens } from "./metrics.js";
import type { Metrics } from "./metrics.js";

/**
 * Phase R — result optimization.
 *
 * Definitions are trimmed before a call (Phase 1/5); this trims the *result*
 * that flows back into the model context. Default posture is **lossless**: an
 * oversized result is stored whole and replaced in-context with a preview plus
 * a `resultId`, and the remainder is fetched on demand via `get_result`.
 */

/** Rough cl100k chars-per-token ratio, used only to size the preview slice.
 *  The deferred-token metric is measured exactly with `countTokens`. */
const CHARS_PER_TOKEN = 4;

interface StoredResult {
  full: string;
  totalTokens: number;
  createdAt: number;
}

/** A slice of a stored result, as returned to `get_result`. */
export interface ResultSlice {
  slice: string;
  shown: number;
  total: number;
  remaining: number;
}

/**
 * Holds full payloads of spilled results so the client can page through them
 * after the preview. Backed by an in-memory map or by JSON files under
 * `<stateDir>/results/`. A periodic sweep drops entries past their TTL.
 */
export class ResultStore {
  private readonly mem = new Map<string, StoredResult>();
  private readonly dir: string;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly cfg: ResultsConfig,
    stateDir: string,
  ) {
    this.dir = join(stateDir, "results");
    if (cfg.store === "disk") mkdirSync(this.dir, { recursive: true });

    const ttlMs = cfg.ttlSeconds * 1000;
    this.sweeper = setInterval(() => this.sweep(ttlMs), Math.min(ttlMs, 60_000));
    // Don't keep the process alive just for the sweep.
    this.sweeper.unref?.();
  }

  /** Store a full payload, returning its `resultId`. */
  put(full: string, totalTokens: number): string {
    const id = randomUUID();
    const rec: StoredResult = { full, totalTokens, createdAt: Date.now() };
    if (this.cfg.store === "disk") {
      writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(rec), "utf8");
    } else {
      this.mem.set(id, rec);
    }
    return id;
  }

  /** Read a `[offset, offset+limit)` character window of a stored result, or
   *  `null` if the id is unknown/expired. */
  get(id: string, offset: number, limit: number): ResultSlice | null {
    const rec = this.load(id);
    if (!rec) return null;
    const start = Math.max(0, offset);
    const slice = rec.full.slice(start, start + Math.max(0, limit));
    const remaining = Math.max(0, rec.full.length - (start + slice.length));
    return { slice, shown: slice.length, total: rec.full.length, remaining };
  }

  private load(id: string): StoredResult | null {
    if (this.cfg.store !== "disk") return this.mem.get(id) ?? null;
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as StoredResult;
    } catch {
      return null;
    }
  }

  private sweep(ttlMs: number): void {
    const cutoff = Date.now() - ttlMs;
    if (this.cfg.store !== "disk") {
      for (const [id, rec] of this.mem) {
        if (rec.createdAt < cutoff) this.mem.delete(id);
      }
      return;
    }
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(this.dir, file);
      try {
        const rec = JSON.parse(readFileSync(path, "utf8")) as StoredResult;
        if (rec.createdAt < cutoff) rmSync(path, { force: true });
      } catch {
        rmSync(path, { force: true });
      }
    }
  }

  /** Stop the sweeper and discard everything. Call on shutdown. */
  dispose(): void {
    clearInterval(this.sweeper);
    this.mem.clear();
    if (this.cfg.store === "disk" && existsSync(this.dir)) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** Context a single result needs to be policed. */
export interface PolicyContext {
  cfg: ResultsConfig;
  store: ResultStore;
  metrics?: Metrics;
  server: string;
  name: string;
}

/**
 * Apply the result policy to one downstream result. Small results (and errors)
 * pass through untouched; oversized ones are spilled (lossless) or truncated
 * (lossy, opt-in) per `cfg.strategy`. Records deferred tokens on `metrics`.
 */
export async function applyResultPolicy(
  result: DispatchResult,
  ctx: PolicyContext,
): Promise<DispatchResult> {
  // Never rewrite error results — the agent needs them verbatim.
  if (result.isError) return result;

  const { cfg } = ctx;

  // The textual payload is the unit the client reads (and pages through).
  let text = result.content.map((c) => c.text ?? "").join("");

  // Opt-in per-tool field projection, applied before measuring so it can bring
  // a result under budget. Keyed by bare name first, then "server.name".
  const drop = cfg.dropFields[ctx.name] ?? cfg.dropFields[`${ctx.server}.${ctx.name}`];
  const projected = drop?.length ? projectFields(text, drop) : null;
  if (projected !== null) text = projected;

  const tokens = await countTokens(text);

  // Under budget (or policy disabled) → emit as-is. If we projected fields, the
  // (smaller) projected text replaces the content; otherwise pass through the
  // original object untouched for zero overhead.
  if (cfg.strategy === "passthrough" || tokens <= cfg.maxTokens) {
    return projected !== null ? { ...result, content: [{ type: "text", text }] } : result;
  }

  const budgetChars = cfg.maxTokens * CHARS_PER_TOKEN;

  if (cfg.strategy === "truncate") {
    const slice = text.slice(0, budgetChars);
    const shown = await countTokens(slice);
    ctx.metrics?.recordDeferred(tokens - shown);
    return {
      ...result,
      content: [
        { type: "text", text: slice },
        {
          type: "text",
          text: `\n[truncated: ~${shown}/${tokens} tokens shown; ${text.length - slice.length} more chars dropped]`,
        },
      ],
    };
  }

  // Default: spill — lossless. Store the whole payload, return a preview + handle.
  const id = ctx.store.put(text, tokens);
  const preview = text.slice(0, budgetChars);
  const shown = await countTokens(preview);
  ctx.metrics?.recordDeferred(tokens - shown);

  const meta = {
    resultId: id,
    shownChars: preview.length,
    totalChars: text.length,
    remainingChars: text.length - preview.length,
    totalTokens: tokens,
    hint:
      `Large result deferred (showing ~${shown}/${tokens} tokens). Read the rest with ` +
      `get_result { resultId: "${id}", offset: ${preview.length} }.`,
  };

  return {
    ...result,
    content: [
      { type: "text", text: preview },
      { type: "text", text: JSON.stringify(meta) },
    ],
  };
}

/** Drop named top-level fields from a JSON result (array elements handled
 *  element-wise). Non-JSON text is returned unchanged. Shallow by design. */
function projectFields(text: string, fields: string[]): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return text;
  }
  const strip = (o: unknown): void => {
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const f of fields) delete (o as Record<string, unknown>)[f];
    }
  };
  if (Array.isArray(data)) data.forEach(strip);
  else strip(data);
  return JSON.stringify(data);
}
