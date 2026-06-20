import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHostServers } from "../src/discover.js";

/** Fresh temp dir, auto-cleaned. */
function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rag-mcp-discover-"));
}

function writeJson(dir: string, file: string, content: string): string {
  const path = join(dir, file);
  writeFileSync(path, content, "utf8");
  return path;
}

test("imports a standard mcpServers block via --from", () => {
  const dir = tmpDir();
  const cfg = writeJson(
    dir,
    "mcp.json",
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        figma: { url: "https://figma.example/mcp" },
      },
    }),
  );
  const { servers, sources } = discoverHostServers({ sources: [cfg] });
  assert.deepEqual(Object.keys(servers).sort(), ["figma", "github"]);
  assert.equal(servers.github.command, "npx");
  assert.equal(servers.figma.url, "https://figma.example/mcp");
  assert.equal(sources.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("normalizes VS Code 'servers', array-command and 'environment'", () => {
  const dir = tmpDir();
  const cfg = writeJson(
    dir,
    "vscode.json",
    JSON.stringify({
      servers: {
        // OpenCode-style array command + `environment` instead of `env`
        local: { command: ["node", "server.js", "--port", "3000"], environment: { TOKEN: "abc" } },
        // VS Code http transport
        remote: { type: "http", url: "https://example.com/mcp" },
      },
    }),
  );
  const { servers } = discoverHostServers({ sources: [cfg] });
  assert.equal(servers.local.command, "node");
  assert.deepEqual(servers.local.args, ["server.js", "--port", "3000"]);
  assert.deepEqual(servers.local.env, { TOKEN: "abc" });
  assert.equal(servers.remote.url, "https://example.com/mcp");
  rmSync(dir, { recursive: true, force: true });
});

test("skips disabled entries and the router itself", () => {
  const dir = tmpDir();
  const cfg = writeJson(
    dir,
    "mcp.json",
    JSON.stringify({
      mcpServers: {
        off: { command: "x", disabled: true },
        "rag-mcp-router": { command: "npx", args: ["-y", "rag-mcp-router"] },
        wrapped: { command: "npx", args: ["-y", "rag-mcp-router", "--config", "x.json"] },
        keep: { command: "real-server" },
      },
    }),
  );
  const { servers } = discoverHostServers({ sources: [cfg] });
  assert.deepEqual(Object.keys(servers), ["keep"]);
  rmSync(dir, { recursive: true, force: true });
});

test("tolerates JSONC comments and trailing commas without breaking URLs", () => {
  const dir = tmpDir();
  const cfg = writeJson(
    dir,
    "opencode.jsonc",
    `{
      // user's servers
      "mcpServers": {
        "api": { "url": "https://api.example.com/mcp" }, /* note the // in the url */
      },
    }`,
  );
  const { servers } = discoverHostServers({ sources: [cfg] });
  assert.equal(servers.api.url, "https://api.example.com/mcp");
  rmSync(dir, { recursive: true, force: true });
});

test("first source wins on name conflict", () => {
  const dir = tmpDir();
  const a = writeJson(dir, "a.json", JSON.stringify({ mcpServers: { dup: { command: "from-a" } } }));
  const b = writeJson(dir, "b.json", JSON.stringify({ mcpServers: { dup: { command: "from-b" } } }));
  const { servers } = discoverHostServers({ sources: [a, b] });
  assert.equal(servers.dup.command, "from-a");
  rmSync(dir, { recursive: true, force: true });
});

test("reads per-project mcpServers from a ~/.claude.json-style file", () => {
  const dir = tmpDir();
  const projectDir = join(dir, "proj");
  mkdirSync(projectDir);
  const cfg = writeJson(
    dir,
    "claude.json",
    JSON.stringify({ projects: { [projectDir]: { mcpServers: { scoped: { command: "p" } } } } }),
  );
  const { servers } = discoverHostServers({ sources: [cfg], cwd: projectDir });
  assert.equal(servers.scoped.command, "p");
  rmSync(dir, { recursive: true, force: true });
});

test("missing and unparseable files are skipped, not fatal", () => {
  const dir = tmpDir();
  const bad = writeJson(dir, "bad.json", "{ not json");
  const { servers, sources } = discoverHostServers({
    sources: [join(dir, "nope.json"), bad],
  });
  assert.deepEqual(servers, {});
  assert.deepEqual(sources, []);
  rmSync(dir, { recursive: true, force: true });
});
