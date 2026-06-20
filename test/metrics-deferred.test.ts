import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "../src/metrics.js";

test("recordDeferred accumulates result-side deferred tokens (Phase R)", () => {
  const m = new Metrics(1000, 100);
  m.recordDeferred(200);
  m.recordDeferred(50);
  assert.equal(m.snapshot().resultTokensDeferred, 250);
});

test("recordDeferred ignores zero and negative amounts", () => {
  const m = new Metrics(0, 0);
  m.recordDeferred(0);
  m.recordDeferred(-10);
  assert.equal(m.snapshot().resultTokensDeferred, 0);
});

test("the result-side axis is independent of definition-side accounting", () => {
  const m = new Metrics(1000, 100);
  m.recordCall("github", "create_issue");
  m.recordDeferred(300);
  const s = m.snapshot();
  assert.equal(s.resultTokensDeferred, 300);
  assert.equal(s.totalCalls, 1);
  // No search_tools request was recorded, so definition-side savings stay zero.
  assert.equal(s.sessionSavedSum, 0);
});
