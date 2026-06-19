# rag-mcp-router

**Open-source RAG router for MCP.** Put it in front of all your MCP servers and
it exposes only the *relevant* tools per query — instead of dumping 100+ tool
definitions into your agent's context on every request.

> 5 servers × 30 tools = 150 tools ≈ 30–60K tokens of metadata before the agent
> does anything. That eats 25–30% of a 200K window, causes "context rot" (the
> model picks the wrong tool), and blows past hard caps like Cursor's 40-tool
> limit. `rag-mcp-router` fixes that.

- **Fully open source** — Apache-2.0, no open-core, no telemetry.
- **Local-first** — tool retrieval runs on local embeddings; no API key required.
- **Drop-in** — config uses the same `mcpServers` shape as Claude/Cursor.

## How it works

The router is an MCP **server** to your client and an MCP **client** to your
downstream servers. Your client sees only four facade tools:

| Tool | Purpose |
|------|---------|
| `search_tools(intent)` | Semantic search — returns only the tools relevant to your intent |
| `call_tool(server, name, arguments)` | Invokes a tool returned by `search_tools` |
| `list_servers()` | Lists downstream servers with connection status |
| `get_metrics()` | Live token-savings accounting for the session |

```
client ──(4 facade tools)──▶ rag-mcp-router ──(N servers)──▶ github, postgres, figma, …
```

## Status

✅ **Usable.** The client → router → downstream chain works end to end with
**local-embeddings semantic retrieval** (fastembed / bge-small, persisted index,
no API key), a **dual-mode token-savings dashboard** (`report.html` on shutdown),
config validation, graceful downstream reconnect, and a unit-test + CI suite.
Streamable HTTP transport and advanced retrieval are next — see the roadmap.

## Quick start

Run it directly with `npx` (no clone needed):

```bash
cp rag-mcp.config.example.json rag-mcp.config.json   # edit to your servers
npx rag-mcp-router --config rag-mcp.config.json
```

Or from a clone:

```bash
pnpm install
pnpm build
node dist/index.js --config rag-mcp.config.json
```

Then point your MCP client at the router as its single server:

```json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["-y", "rag-mcp-router", "--config", "/abs/path/to/rag-mcp.config.json"]
    }
  }
}
```

The first run downloads the embedding model once (cached under `.rag-mcp/`);
after that, retrieval is fully offline.

## Development

```bash
pnpm install
pnpm build      # tsc → dist/
pnpm test       # node:test unit suite (tsx)
pnpm smoke      # end-to-end: client → router → downstream (server-everything)
```

## Roadmap

- [x] Walking skeleton: facade tools, downstream manager, dispatcher
- [x] Local-embeddings RAG retrieval (fastembed / bge-small) + persisted index
- [x] Dual-mode metrics: `$ saved` (API) / `freed context, plan headroom` (subscription)
- [x] HTML dashboard on shutdown
- [x] Hardening & DX: config validation, reconnect, unit tests + CI
- [ ] BM25 hybrid + reranker, pinned tools
- [ ] Streamable HTTP transport (remote / team)
- [ ] Profiles / allowlists, new-tool quarantine
- [ ] Live re-index on downstream `list_changed`

## License

Apache-2.0
