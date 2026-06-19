import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

/** Write `obj` (or raw string) to a temp config file and return its path. */
function tmpConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rag-mcp-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return path;
}

test("applies defaults for omitted sections", () => {
  const cfg = loadConfig(tmpConfig({ mcpServers: { gh: { command: "npx" } } }));
  assert.equal(cfg.billing.mode, "subscription");
  assert.equal(cfg.billing.client, "generic");
  assert.equal(cfg.billing.contextWindow, 200000);
  assert.equal(cfg.embedding.backend, "local");
  assert.equal(cfg.embedding.model, "bge-small-en-v1.5");
  assert.equal(cfg.retrieval.topK, 6);
  assert.equal(cfg.retrieval.hybrid, true);
});

test("accepts a url-based (HTTP) server", () => {
  const cfg = loadConfig(tmpConfig({ mcpServers: { remote: { url: "https://example.com/mcp" } } }));
  assert.equal(cfg.mcpServers.remote.url, "https://example.com/mcp");
});

test("rejects empty mcpServers with a clear message", () => {
  assert.throws(() => loadConfig(tmpConfig({ mcpServers: {} })), /mcpServers.*empty/s);
});

test("rejects a server that sets both command and url", () => {
  assert.throws(
    () => loadConfig(tmpConfig({ mcpServers: { x: { command: "npx", url: "https://e.com" } } })),
    /exactly one of/,
  );
});

test("rejects a server that sets neither command nor url", () => {
  assert.throws(
    () => loadConfig(tmpConfig({ mcpServers: { x: {} } })),
    /exactly one of/,
  );
});

test("rejects an invalid billing mode with a path-prefixed message", () => {
  assert.throws(
    () => loadConfig(tmpConfig({ billing: { mode: "free" }, mcpServers: { x: { command: "n" } } })),
    /billing\.mode/,
  );
});

test("rejects unknown top-level keys (typo protection)", () => {
  assert.throws(
    () => loadConfig(tmpConfig({ retreival: { topK: 3 }, mcpServers: { x: { command: "n" } } })),
    /validation failed/,
  );
});

test("reports invalid JSON clearly", () => {
  assert.throws(() => loadConfig(tmpConfig("{ not json ")), /invalid JSON/);
});

test("reports a missing file clearly", () => {
  assert.throws(() => loadConfig("/no/such/path/cfg.json"), /cannot read file/);
});
