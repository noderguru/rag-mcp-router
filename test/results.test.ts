import { test } from "node:test";
import assert from "node:assert/strict";
import { ResultStore, applyResultPolicy, type PolicyContext } from "../src/results.js";
import type { ResultsConfig } from "../src/config.js";
import type { DispatchResult } from "../src/dispatch.js";
import { Metrics } from "../src/metrics.js";

const baseCfg: ResultsConfig = {
  maxTokens: 50,
  strategy: "spill",
  store: "memory",
  ttlSeconds: 900,
  dropFields: {},
};

function ctx(over: Partial<ResultsConfig> = {}): { ctx: PolicyContext; store: ResultStore; metrics: Metrics } {
  const cfg = { ...baseCfg, ...over };
  const store = new ResultStore(cfg, ".rag-mcp-test");
  const metrics = new Metrics(0, 0);
  return { ctx: { cfg, store, metrics, server: "s", name: "t" }, store, metrics };
}

function textResult(text: string): DispatchResult {
  return { content: [{ type: "text", text }] };
}

const big = (n: number) => "x".repeat(n);

test("small results pass through untouched (zero overhead)", async () => {
  const { ctx: c, metrics } = ctx();
  const res = textResult("tiny");
  const out = await applyResultPolicy(res, c);
  assert.equal(out, res); // same object reference — nothing rewritten
  assert.equal(metrics.snapshot().resultTokensDeferred, 0);
});

test("error results are never rewritten", async () => {
  const { ctx: c } = ctx();
  const res: DispatchResult = { isError: true, content: [{ type: "text", text: big(10000) }] };
  const out = await applyResultPolicy(res, c);
  assert.equal(out, res);
});

test("spill is lossless: preview + resultId, get_result reconstructs the whole payload", async () => {
  const { ctx: c, store, metrics } = ctx();
  const full = big(4000);
  const out = await applyResultPolicy(textResult(full), c);

  // preview block + metadata block
  assert.equal(out.content.length, 2);
  const meta = JSON.parse(out.content[1].text) as { resultId: string; totalChars: number; remainingChars: number };
  assert.equal(meta.totalChars, full.length);
  assert.ok(meta.remainingChars > 0);
  assert.ok(metrics.snapshot().resultTokensDeferred > 0);

  // Page through the rest and confirm preview + remainder === original.
  const preview = out.content[0].text;
  const rest = store.get(meta.resultId, preview.length, full.length);
  assert.ok(rest);
  assert.equal(preview + rest!.slice, full);
  assert.equal(rest!.remaining, 0);
});

test("unknown resultId returns null", () => {
  const { store } = ctx();
  assert.equal(store.get("nope", 0, 100), null);
});

test("truncate strategy is lossy and stores nothing", async () => {
  const { ctx: c, metrics } = ctx({ strategy: "truncate" });
  const out = await applyResultPolicy(textResult(big(4000)), c);
  assert.equal(out.content.length, 2);
  assert.match(out.content[1].text, /truncated/);
  assert.ok(metrics.snapshot().resultTokensDeferred > 0);
});

test("passthrough strategy never trims even oversized results", async () => {
  const { ctx: c } = ctx({ strategy: "passthrough" });
  const res = textResult(big(4000));
  const out = await applyResultPolicy(res, c);
  assert.equal(out, res);
});

test("dropFields projects noisy fields out before measuring", async () => {
  const { ctx: c } = ctx({ maxTokens: 2000, dropFields: { t: ["blob"] } });
  const payload = JSON.stringify([{ id: 1, blob: big(50) }, { id: 2, blob: big(50) }]);
  const out = await applyResultPolicy(textResult(payload), c);
  const parsed = JSON.parse(out.content[0].text);
  assert.deepEqual(parsed, [{ id: 1 }, { id: 2 }]);
});
