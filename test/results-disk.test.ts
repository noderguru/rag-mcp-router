import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultStore } from "../src/results.js";
import type { ResultsConfig } from "../src/config.js";

const cfg = (over: Partial<ResultsConfig> = {}): ResultsConfig => ({
  maxTokens: 50,
  strategy: "spill",
  store: "disk",
  ttlSeconds: 900,
  dropFields: {},
  ...over,
});

function withStore(c: ResultsConfig, fn: (store: ResultStore, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rmr-disk-"));
  const store = new ResultStore(c, dir);
  try {
    fn(store, dir);
  } finally {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("disk store: put writes a file and get round-trips the whole payload", () => {
  withStore(cfg(), (store, dir) => {
    const full = "abc".repeat(1000);
    const id = store.put(full, 123);
    assert.ok(existsSync(join(dir, "results", `${id}.json`)), "result persisted to disk");
    const slice = store.get(id, 0, full.length);
    assert.ok(slice);
    assert.equal(slice!.slice, full);
    assert.equal(slice!.total, full.length);
    assert.equal(slice!.remaining, 0);
  });
});

test("disk store: paged get reports the remaining tail", () => {
  withStore(cfg(), (store) => {
    const full = "x".repeat(1000);
    const id = store.put(full, 250);
    const head = store.get(id, 0, 400);
    assert.ok(head);
    assert.equal(head!.shown, 400);
    assert.equal(head!.remaining, 600);
  });
});

test("disk store: get returns null for an unknown id", () => {
  withStore(cfg(), (store) => {
    assert.equal(store.get("missing", 0, 10), null);
  });
});

test("disk store: sweep drops expired entries but keeps fresh ones", () => {
  withStore(cfg(), (store) => {
    const id = store.put("y".repeat(200), 20);
    // A generous TTL (cutoff in the past) keeps a just-written entry.
    (store as unknown as { sweep(ttlMs: number): void }).sweep(60_000);
    assert.ok(store.get(id, 0, 10), "fresh entry survives");
    // A negative TTL puts the cutoff in the future → everything is expired.
    (store as unknown as { sweep(ttlMs: number): void }).sweep(-1000);
    assert.equal(store.get(id, 0, 10), null, "expired entry swept");
  });
});

test("memory store: sweep drops expired entries", () => {
  withStore(cfg({ store: "memory" }), (store) => {
    const id = store.put("z".repeat(200), 20);
    assert.ok(store.get(id, 0, 10));
    (store as unknown as { sweep(ttlMs: number): void }).sweep(-1000);
    assert.equal(store.get(id, 0, 10), null);
  });
});

test("dispose cleans up the disk results directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmr-disk-"));
  const store = new ResultStore(cfg(), dir);
  store.put("x".repeat(100), 10);
  const resultsDir = join(dir, "results");
  assert.ok(existsSync(resultsDir));
  store.dispose();
  assert.ok(!existsSync(resultsDir), "results dir removed on dispose");
  rmSync(dir, { recursive: true, force: true });
});
