import { test } from "node:test";
import assert from "node:assert/strict";
import { mmr } from "../src/index/rerank.js";

// 2-D unit vectors:
//   A = [1, 0]          (identical to query)
//   B = [0.99, 0.1411]  (near-duplicate of A)
//   C = [0, 1]          (orthogonal — diverse)
const vectors = [
  [1, 0],
  [0.99, 0.1411],
  [0, 1],
];
const query = [1, 0];

test("λ=1 is pure relevance: keeps the most-similar order", () => {
  const out = mmr(query, [0, 1, 2], vectors, 1, 2);
  assert.deepEqual(out, [0, 1]);
});

test("λ=0 favors diversity: picks the orthogonal item over the near-duplicate", () => {
  const out = mmr(query, [0, 1, 2], vectors, 0, 2);
  assert.deepEqual(out, [0, 2]);
});

test("returns min(k, pool) items", () => {
  assert.equal(mmr(query, [0, 1, 2], vectors, 0.7, 2).length, 2);
  assert.equal(mmr(query, [0, 1], vectors, 0.7, 5).length, 2);
});

test("selection is a permutation of a subset of the candidates", () => {
  const out = mmr(query, [0, 1, 2], vectors, 0.5, 3);
  assert.deepEqual([...out].sort(), [0, 1, 2]);
});
