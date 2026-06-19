# rag-mcp-router

**Open-source RAG router for MCP.** Put it in front of all your MCP servers and
it exposes only the *relevant* tools per query — instead of dumping 100+ tool
definitions into your agent's context on every request.

> 5 servers × 30 tools = 150 tools ≈ 30–60K tokens of metadata before the agent
> does anything. That eats 25–30% of a 200K window, causes "context rot" (the
> model picks the wrong tool), and blows past hard caps like Cursor's 40-tool
> limit. `rag-mcp-router` fixes that.

- **Vendor-neutral** — works with *any* MCP-capable client (Cursor, Cline, Claude
  Code, OpenCode, Kimi, …), not just one vendor's harness.
- **Semantic** — retrieval runs on local embeddings (vector similarity), not just
  lexical keyword/BM25 matching.
- **Local-first** — no API key, no network at runtime once the model is cached.
- **Fully open source** — Apache-2.0, no open-core, no telemetry.
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

## Prior art & how we differ

Dynamic tool discovery to fight context bloat is **not a novel idea** — it's a
validated, actively-developed space. Be clear-eyed about that:

- **Anthropic's [Tool Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)**
  ships this natively and is built into Claude Code for MCP. It uses **BM25 +
  regex** (lexical) and is **Claude-only / API-side**.
- The **[RAG-MCP paper](https://arxiv.org/abs/2505.03275)** (May 2025) describes
  exactly this retrieval-based approach (−50% tokens, ×3 selection accuracy).
- Open-source gateways already do semantic or optimized tool routing —
  e.g. [agentic-community/mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)
  (FAISS + sentence-transformers, enterprise/K8s-oriented) and
  [abdullah1854/MCPGateway](https://github.com/abdullah1854/MCPGateway)
  (pattern-matching + token-optimization layers).

We don't claim to be first. Our niche is the **specific intersection** no single
one of the above covers:

| | rag-mcp-router | Anthropic Tool Search | Enterprise MCP gateways |
|---|---|---|---|
| Works with **any** MCP client | ✅ | ❌ Claude-only | ✅ |
| Retrieval | **Semantic (embeddings)** | Lexical (BM25/regex) | Mixed |
| Runs **fully local, no API key** | ✅ | ❌ (API-side) | ⚠️ optional |
| Setup weight | single binary / `npx` | n/a | server / K8s / OAuth |
| Token-savings transparency | ✅ dual-mode dashboard | partial | varies |
| License | Apache-2.0 | proprietary | mixed |

In one line: **an open, local-first, vendor-neutral alternative to Claude-only
Tool Search — semantic tool selection for any agent, with transparent savings.**

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

## Retrieval tuning

Defaults work out of the box; these `retrieval` config knobs let you tune it:

| Key | Default | What it does |
|-----|---------|--------------|
| `topK` | `6` | How many tools `search_tools` returns |
| `hybrid` | `true` | Blend lexical **BM25** with semantic cosine |
| `alpha` / `beta` | `0.7` / `0.3` | Weights of the semantic vs lexical score in the blend |
| `rerank` | `false` | Re-rank the candidate pool with **MMR** (relevance vs diversity) |
| `rerankLambda` | `0.7` | MMR tradeoff — `1.0` = pure relevance, `0.0` = pure diversity |
| `candidates` | `20` | First-stage pool size fed to the reranker |
| `pinned` | `[]` | Tools (`"server.name"`) exposed directly, callable without `search_tools` |

> **Pick settings with data, not vibes.** `pnpm bench` runs a labeled query set and
> reports top-1 / top-3 accuracy and MRR for semantic vs hybrid vs hybrid+MMR, so
> you can see whether a change actually helps before shipping it. Edit
> `test/eval/*.json` to benchmark against your own tools and queries.

Semantic retrieval alone is already strong on small/medium catalogs; **hybrid**
earns its keep when queries contain exact identifiers or rare jargon, and at
larger tool counts. **MMR** trades a little top-k precision for diversity, so it's
off by default — enable it when near-duplicate tools crowd your results.

## Development

```bash
pnpm install
pnpm build      # tsc → dist/
pnpm test       # node:test unit suite (tsx)
pnpm smoke      # end-to-end: client → router → downstream (server-everything)
pnpm bench      # retrieval quality benchmark (needs `pnpm build` first)
```

## Roadmap

- [x] Walking skeleton: facade tools, downstream manager, dispatcher
- [x] Local-embeddings RAG retrieval (fastembed / bge-small) + persisted index
- [x] Dual-mode metrics: `$ saved` (API) / `freed context, plan headroom` (subscription)
- [x] HTML dashboard on shutdown
- [x] Hardening & DX: config validation, reconnect, unit tests + CI
- [x] Advanced retrieval: BM25 hybrid, MMR rerank, pinned tools, eval benchmark
- [ ] Streamable HTTP transport (remote / team)
- [ ] Profiles / allowlists, new-tool quarantine
- [ ] Live re-index on downstream `list_changed`

## License

Apache-2.0
