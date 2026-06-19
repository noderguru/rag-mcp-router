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
downstream servers. Your client sees only three facade tools:

| Tool | Purpose |
|------|---------|
| `search_tools(intent)` | Returns only the tools relevant to your intent |
| `call_tool(server, name, arguments)` | Invokes a tool returned by `search_tools` |
| `list_servers()` | Lists connected downstream servers |

```
client ──(3 facade tools)──▶ rag-mcp-router ──(N servers)──▶ github, postgres, figma, …
```

## Status

🚧 **Walking skeleton.** The client → router → downstream chain works end to end.
`search_tools` currently uses naive keyword matching — the local-embeddings RAG
core, the dual-mode token-savings dashboard, and Streamable HTTP transport are
next. See the roadmap below.

## Quick start

```bash
pnpm install
pnpm build
cp rag-mcp.config.example.json rag-mcp.config.json   # edit to your servers
node dist/index.js --config rag-mcp.config.json
```

Then point your MCP client at the router as its single server:

```json
{
  "mcpServers": {
    "router": {
      "command": "node",
      "args": ["/abs/path/to/rag-mcp-router/dist/index.js", "--config", "/abs/path/to/rag-mcp.config.json"]
    }
  }
}
```

## Roadmap

- [x] Walking skeleton: facade tools, downstream manager, dispatcher
- [ ] Local-embeddings RAG retrieval (fastembed / bge-small) + persisted index
- [ ] Dual-mode metrics: `$ saved` (API) / `freed context, plan headroom` (subscription)
- [ ] HTML dashboard on SessionEnd
- [ ] BM25 hybrid + reranker, pinned tools
- [ ] Streamable HTTP transport (remote / team)
- [ ] Profiles / allowlists, new-tool quarantine
- [ ] Live re-index on downstream `list_changed`

## License

Apache-2.0
