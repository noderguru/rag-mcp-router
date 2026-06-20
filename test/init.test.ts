import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The built CLI. `npm run build` must have run first (CI builds before testing).
const CLI = resolve(fileURLToPath(import.meta.url), "../../dist/index.js");

function runInDir(dir: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
}

test("init scaffolds a valid rag-mcp.config.json in the cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmr-init-"));
  try {
    const r = runInDir(dir, ["init"]);
    assert.equal(r.status, 0, r.stderr);
    const cfgPath = join(dir, "rag-mcp.config.json");
    assert.ok(existsSync(cfgPath), "config file created");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.ok(cfg.mcpServers, "scaffolded config has an mcpServers block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init never overwrites an existing config", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmr-init-"));
  try {
    const cfgPath = join(dir, "rag-mcp.config.json");
    writeFileSync(cfgPath, '{"sentinel":true}', "utf8");
    const r = runInDir(dir, ["init"]);
    assert.match(r.stderr, /already exists/);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")), { sentinel: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--help prints usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmr-help-"));
  try {
    const r = runInDir(dir, ["--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /rag-mcp-router init/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
