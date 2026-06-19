import { test } from "node:test";
import assert from "node:assert/strict";
import { Bm25Index } from "../src/index/bm25.js";

const docs = [
  "github create_issue open a new issue in a repository",
  "postgres run_query execute a sql select statement and return rows",
  "files read_file read the contents of a file from disk",
];

test("scoreAll returns one score per document", () => {
  const idx = new Bm25Index(docs);
  assert.equal(idx.size, 3);
  assert.equal(idx.scoreAll("sql").length, 3);
});

test("a rare term ranks only the document that contains it", () => {
  const idx = new Bm25Index(docs);
  const scores = idx.scoreAll("sql");
  assert.ok(scores[1] > 0, "postgres doc should match 'sql'");
  assert.equal(scores[0], 0);
  assert.equal(scores[2], 0);
});

test("the highest-scoring doc for a query term is the right one", () => {
  const idx = new Bm25Index(docs);
  const scores = idx.scoreAll("repository issue");
  const top = scores.indexOf(Math.max(...scores));
  assert.equal(top, 0);
});

test("empty / non-matching queries score all zeros", () => {
  const idx = new Bm25Index(docs);
  assert.deepEqual(idx.scoreAll(""), [0, 0, 0]);
  assert.deepEqual(idx.scoreAll("zzzznomatch"), [0, 0, 0]);
});

test("tokenization is case- and punctuation-insensitive", () => {
  const idx = new Bm25Index(docs);
  assert.ok(idx.scoreAll("SQL!")[1] > 0);
});

test("an empty corpus is handled without error", () => {
  const idx = new Bm25Index([]);
  assert.deepEqual(idx.scoreAll("anything"), []);
});
