import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics, countTokens, toolSchemaTokens } from "../src/metrics.js";
import type { ToolHit } from "../src/retriever.js";

const tool = (server: string, name: string, description: string): ToolHit => ({
  server,
  name,
  description,
  inputSchema: { type: "object", properties: { arg: { type: "string" } } },
});

test("countTokens: empty is 0, non-empty is positive", async () => {
  assert.equal(await countTokens(""), 0);
  assert.ok((await countTokens("hello world")) > 0);
});

test("fresh Metrics snapshot is all zeros", () => {
  const m = new Metrics(100, 10);
  const snap = m.snapshot();
  assert.equal(snap.totalRequests, 0);
  assert.equal(snap.totalCalls, 0);
  assert.equal(snap.sessionSavedSum, 0);
  assert.equal(snap.baselinePerRequest, 100);
  assert.equal(snap.facadeTokens, 10);
  assert.deepEqual(snap.perToolCalls, []);
  assert.deepEqual(snap.surfacedThisSession, []);
});

test("recordRequest accounts saved = baseline - (facade + surfaced) per §5.1", async () => {
  const baseline = 1000;
  const facade = 50;
  const m = new Metrics(baseline, facade);
  const surfaced = [tool("github", "create_issue", "Open a new issue")];
  const surfacedTokens = await toolSchemaTokens(surfaced[0]);

  await m.recordRequest(surfaced);
  const snap = m.snapshot();

  assert.equal(snap.totalRequests, 1);
  assert.equal(snap.sessionBaselineSum, baseline);
  assert.equal(snap.sessionActualSum, facade + surfacedTokens);
  assert.equal(snap.sessionSavedSum, baseline - (facade + surfacedTokens));
  assert.deepEqual(snap.surfacedThisSession, ["github.create_issue"]);
});

test("sums aggregate across requests; surfaced set dedupes", async () => {
  const m = new Metrics(1000, 50);
  await m.recordRequest([tool("a", "one", "first")]);
  await m.recordRequest([tool("a", "one", "first"), tool("b", "two", "second")]);
  const snap = m.snapshot();
  assert.equal(snap.totalRequests, 2);
  assert.equal(snap.sessionBaselineSum, 2000);
  // de-duplicated surfacings across both requests
  assert.deepEqual(snap.surfacedThisSession.sort(), ["a.one", "b.two"]);
});

test("recordCall counts per tool", () => {
  const m = new Metrics(100, 10);
  m.recordCall("github", "create_issue");
  m.recordCall("github", "create_issue");
  m.recordCall("fs", "read_file");
  const snap = m.snapshot();
  assert.equal(snap.totalCalls, 3);
  const gh = snap.perToolCalls.find((p) => p.server === "github" && p.name === "create_issue");
  const fs = snap.perToolCalls.find((p) => p.server === "fs" && p.name === "read_file");
  assert.equal(gh?.calls, 2);
  assert.equal(fs?.calls, 1);
});
