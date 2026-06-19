import { test } from "node:test";
import assert from "node:assert/strict";
import { VectorStore } from "../src/index/store.js";
import { toDocument, catalogHash, KeywordRetriever, type ToolHit } from "../src/retriever.js";

const tool = (server: string, name: string, description?: string, params: string[] = []): ToolHit => ({
  server,
  name,
  description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p, { type: "string" }])),
  },
});

test("toDocument includes server.name, description and param keys", () => {
  const doc = toDocument(tool("github", "create_issue", "Open a new issue", ["title", "body"]));
  assert.equal(doc, "github.create_issue: Open a new issue | params: title, body");
});

test("toDocument omits the params clause when there are none", () => {
  const doc = toDocument(tool("everything", "echo", "Echo a message"));
  assert.equal(doc, "everything.echo: Echo a message");
});

test("catalogHash is stable and sensitive to model + docs", () => {
  const docs = ["a", "b"];
  assert.equal(catalogHash("m1", docs), catalogHash("m1", docs));
  assert.notEqual(catalogHash("m1", docs), catalogHash("m2", docs));
  assert.notEqual(catalogHash("m1", docs), catalogHash("m1", ["a", "c"]));
});

test("VectorStore.search ranks by cosine (dot of normalized vectors) and respects k", () => {
  // 2-D unit vectors. Query points along +x; closest is index 0.
  const store = VectorStore.fromVectors([
    [1, 0], // identical to query
    [0.7071, 0.7071], // 45°
    [0, 1], // orthogonal
  ]);
  const ranked = store.search([1, 0], 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].index, 0);
  assert.equal(ranked[1].index, 1);
  assert.ok(ranked[0].score > ranked[1].score);
});

test("VectorStore.search with k >= size returns all, fully ordered", () => {
  const store = VectorStore.fromVectors([[0, 1], [1, 0]]);
  const ranked = store.search([1, 0], 10);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].index, 1);
});

test("KeywordRetriever ranks by term overlap", async () => {
  const r = new KeywordRetriever([
    tool("github", "create_issue", "Open a new issue"),
    tool("everything", "echo", "Echo a message back"),
    tool("fs", "read_file", "Read a file from disk"),
  ]);
  const hits = await r.search("echo a message", 2);
  assert.equal(hits[0].name, "echo");
  assert.equal(hits.length, 2);
});

test("KeywordRetriever falls back to first-k when nothing matches", async () => {
  const catalog = [tool("a", "one"), tool("b", "two"), tool("c", "three")];
  const r = new KeywordRetriever(catalog);
  const hits = await r.search("zzz-nomatch", 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].name, "one");
});

test("KeywordRetriever returns first-k for an empty query", async () => {
  const r = new KeywordRetriever([tool("a", "one"), tool("b", "two")]);
  const hits = await r.search("   ", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "one");
});
