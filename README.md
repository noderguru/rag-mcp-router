# rag-mcp-router

**Semantic tool selection for the Model Context Protocol (MCP).** Put `rag-mcp-router`
in front of all your MCP servers and it exposes only the *relevant* tools per query —
instead of dumping 100+ tool definitions into your agent's context on every request.

[![CI](https://github.com/noderguru/rag-mcp-router/actions/workflows/ci.yml/badge.svg)](https://github.com/noderguru/rag-mcp-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/rag-mcp-router.svg)](https://www.npmjs.com/package/rag-mcp-router)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> **5 servers × 30 tools = 150 tools ≈ 30–60K tokens** of metadata injected into context
> *before the agent does anything*. That eats 25–30% of a 200K window, causes "context rot"
> (the model picks the wrong tool), and blows past hard caps like Cursor's 40-tool limit.
> `rag-mcp-router` fixes that with a local, semantic retrieval layer.

In plain terms: instead of handing your AI agent a giant menu of every tool from every
server at once, the router keeps the menu to itself and hands the agent only the few tools
that actually match what it's trying to do right now.

- **Vendor-neutral** — works with *any* MCP-capable client (Cursor, Cline, Claude Code,
  OpenCode, Kimi, …), not just one vendor's harness.
- **Semantic** — retrieval runs on local embeddings (vector similarity), not just lexical
  keyword/BM25 matching.
- **Local-first** — no API key, no network at runtime once the embedding model is cached.
- **Transparent savings** — every session writes an interactive `report.html` dashboard
  showing exactly how many tokens (and how much money / context) the router saved.
  [▶ Try the live demo](https://htmlpreview.github.io/?https://github.com/noderguru/rag-mcp-router/blob/main/docs/report-prototype.html).
- **Fully open source** — Apache-2.0, no open-core, no telemetry.
- **Drop-in** — config uses the same `mcpServers` shape as Claude/Cursor.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Who it's for](#who-its-for)
- [How it works](#how-it-works)
- [Prior art & how we differ](#prior-art--how-we-differ)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Troubleshooting / FAQ](#troubleshooting--faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why this exists

Every MCP server you connect injects all of its tool definitions — names, descriptions,
and full input schemas — into the model's context window on every request. With a handful
of servers this adds up fast:

- A single well-documented tool is **≈ 200–500 tokens**; 50 tools ≈ **10–25K tokens**.
- Five servers with ~30 tools each ≈ **30–60K tokens**, or **25–30% of a 200K window**,
  spent before the agent has done anything useful.
- **Context rot** — when many tools look similar, the model picks the wrong one more often.
- **Hard caps** — some clients silently forward only a subset of tools (Cursor forwards the
  first **40** across *all* servers; VS Code / Copilot cap at **128**). Tools past the cap
  are simply invisible to the model.

Anthropic validated the approach: Claude's native
[Tool Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
loads only relevant tools when preloaded tools exceed ~10% of the window, cutting token use
by up to **95%**. `rag-mcp-router` brings that to **any** MCP client and **any** set of
servers — locally, with semantic embeddings, and no API key.

## Who it's for

You'll get the most out of this if you:

- **Run several MCP servers at once** (GitHub + Postgres + Figma + filesystem + …) and feel
  the context tax.
- **Use any MCP client**, especially one with a hard tool cap (Cursor, VS Code/Copilot) or
  a smaller/cheaper model that suffers more from tool overload.
- **Want it local and private** — no tool metadata or queries leave your machine.
- **Share a router across a team** (a single curated set of downstream servers).

### Compatible clients

`rag-mcp-router` speaks standard MCP over stdio, so it works with any MCP-capable harness.
Tool caps below are the client's own limits — the router exists precisely to keep you under
them by surfacing only what's relevant.

| Client | Hard tool cap | Works with router |
|--------|---------------|-------------------|
| **Cursor** | **40** (across all MCP servers) | ✅ |
| **VS Code / Copilot** | **128** | ✅ |
| **Claude Code** | none (soft; ships built-in Tool Search) | ✅ |
| **Cline, OpenCode, Windsurf, Cherry Studio, Qwen Code, …** | varies | ✅ |
| **Kimi Code CLI** (Moonshot) | none (256K context) | ✅ |
| **Xiaomi MiMo Code** | none | ✅ |
| **Codex CLI** (OpenAI) | none documented | ✅ |

## How it works

The router is an MCP **server** to your client and an MCP **client** to your downstream
servers. Your client sees only five small facade tools instead of the full catalog:

| Facade tool | Purpose |
|-------------|---------|
| `search_tools(intent, k?)` | Semantic search — returns only the tools relevant to your intent, with their input schemas |
| `call_tool(server, name, arguments)` | Invokes a tool returned by `search_tools`, proxied to the right downstream server |
| `get_result(resultId, offset?, limit?)` | Pages through a large result that `call_tool` deferred (lossless) |
| `list_servers()` | Lists downstream servers with connection status and tool counts |
| `get_metrics()` | Live token-savings accounting for the session |

```
        MCP Client  (Cursor / Claude Code / Cline / Kimi / …)
              │  one connection — sees only 5 facade tools
              ▼
┌─────────────────────────────────────────────────────────────┐
│                       rag-mcp-router                          │
│                                                               │
│   Facade server  (search_tools / call_tool / get_result / …)  │
│        │                         ▲                            │
│        ▼                         │ top-k relevant tools       │
│   Dispatcher  ◀────────▶  Retriever (RAG)  ◀── Tool index     │
│        │                                       (vectors +      │
│        │                                        schemas, BM25) │
│        ▼                                                       │
│   Downstream manager (MCP client to N servers)                │
│   Result optimizer  +  Metrics / dashboard → report.html      │
└─────────────────────────────────────────────────────────────┘
              │ stdio / Streamable HTTP
      ┌───────┼────────┬─────────┐
      ▼       ▼        ▼         ▼
   github  postgres  figma  ...  serverN
```

**The retrieval pipeline:**

1. On startup the router connects to every downstream server, drains their (paginated)
   tool lists, and builds a **catalog**.
2. Each tool is turned into a short document (`server.name: description | params: …`) and
   embedded once with a **local model** (`fastembed` / `bge-small-en-v1.5`). The vector
   index is **persisted** and keyed by a catalog hash, so an unchanged tool set reloads
   instantly without re-embedding.
3. When the agent calls `search_tools`, the query is embedded and scored by cosine
   similarity. In **hybrid** mode (default) this is blended with a lexical **BM25** score
   (`α·cosine + β·bm25`) so exact identifiers and rare jargon still rank well. Optional
   **MMR reranking** trades a little precision for diversity when near-duplicate tools
   crowd the results.
4. The top-k tools (with full schemas) are returned; the agent calls one via `call_tool`.
5. **Result optimization** — if a tool returns a large payload, the router stores it whole
   and hands back a preview plus a `resultId`; the agent reads the rest on demand via
   `get_result`. Nothing is lost, and context stays lean on both the definition *and* the
   result side.

## Prior art & how we differ

Dynamic tool discovery to fight context bloat is **not a novel idea** — it's a validated,
actively-developed space. Be clear-eyed about that:

- **Anthropic's [Tool Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)**
  ships this natively in Claude Code. It uses **BM25 + regex** (lexical) and is
  **Claude-only / API-side**.
- The **[RAG-MCP paper](https://arxiv.org/abs/2505.03275)** (May 2025) describes exactly
  this retrieval-based approach (−50% tokens, ×3 selection accuracy).
- Open-source gateways already do semantic or optimized tool routing — e.g.
  [agentic-community/mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)
  (FAISS + sentence-transformers, enterprise/K8s-oriented) and
  [abdullah1854/MCPGateway](https://github.com/abdullah1854/MCPGateway)
  (pattern-matching + token-optimization layers).

We don't claim to be first. Our niche is the **specific intersection** no single one of the
above covers:

| | rag-mcp-router | Anthropic Tool Search | Enterprise MCP gateways |
|---|---|---|---|
| Works with **any** MCP client | ✅ | ❌ Claude-only | ✅ |
| Retrieval | **Semantic (embeddings)** | Lexical (BM25/regex) | Mixed |
| Runs **fully local, no API key** | ✅ | ❌ (API-side) | ⚠️ optional |
| Setup weight | `npx` / single config | n/a | server / K8s / OAuth |
| Token-savings transparency | ✅ dual-mode dashboard | partial | varies |
| License | Apache-2.0 | proprietary | mixed |

In one line: **an open, local-first, vendor-neutral alternative to Claude-only Tool Search —
semantic tool selection for any agent, with transparent savings.**

## Installation

**Requirements:** Node.js **≥ 20**.

Get started in one command — no clone, no manual file copying:

```bash
npx rag-mcp-router@latest init    # scaffolds rag-mcp.config.json in the current dir
```

Edit the generated `rag-mcp.config.json` to point at your MCP servers, then run:

```bash
npx rag-mcp-router@latest --config rag-mcp.config.json
```

Or from a clone (uses pnpm):

```bash
pnpm install
pnpm build
node dist/index.js --config rag-mcp.config.json
```

Then point your MCP client at the router as its **single** server:

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

The first run downloads the embedding model once (cached under `.rag-mcp/`); after that,
retrieval is fully offline.

## Configuration

The config file mirrors the standard `mcpServers` shape, plus a few tuning blocks. Full
example (also in [`rag-mcp.config.example.json`](./rag-mcp.config.example.json)):

```json
{
  "billing": {
    "mode": "subscription",
    "client": "cursor",
    "contextWindow": 200000
  },
  "embedding": {
    "backend": "local",
    "model": "bge-small-en-v1.5"
  },
  "retrieval": {
    "topK": 6,
    "hybrid": true,
    "alpha": 0.7,
    "beta": 0.3,
    "rerank": false,
    "rerankLambda": 0.7,
    "candidates": 20,
    "pinned": []
  },
  "results": {
    "maxTokens": 2000,
    "strategy": "spill",
    "store": "disk",
    "ttlSeconds": 900,
    "dropFields": {}
  },
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    },
    "figma": {
      "url": "https://figma.example/mcp"
    }
  }
}
```

### `mcpServers`

Each entry sets **exactly one** of `command` (stdio) or `url` (Streamable HTTP) — the same
shape you already use in Claude/Cursor configs, so you can paste your existing servers in.

### `retrieval`

Defaults work out of the box; these knobs let you tune it:

| Key | Default | What it does |
|-----|---------|--------------|
| `topK` | `6` | How many tools `search_tools` returns |
| `hybrid` | `true` | Blend lexical **BM25** with semantic cosine |
| `alpha` / `beta` | `0.7` / `0.3` | Weights of the semantic vs lexical score in the blend |
| `rerank` | `false` | Re-rank the candidate pool with **MMR** (relevance vs diversity) |
| `rerankLambda` | `0.7` | MMR tradeoff — `1.0` = pure relevance, `0.0` = pure diversity |
| `candidates` | `20` | First-stage pool size fed to the reranker |
| `pinned` | `[]` | Tools (`"server.name"`) exposed directly, callable without `search_tools` |

### `results` (result optimization)

Trims large tool **results** before they enter context. Small results pass through
untouched (zero overhead).

| Key | Default | What it does |
|-----|---------|--------------|
| `maxTokens` | `2000` | Results at/under this token count pass through unchanged |
| `strategy` | `"spill"` | `passthrough` (never trim), `spill` (store + preview, **lossless**), or `truncate` (cut with a marker, lossy) |
| `store` | `"disk"` | Where deferred results live: `disk` (`.rag-mcp/results/`) or `memory` |
| `ttlSeconds` | `900` | Deferred results older than this are swept |
| `dropFields` | `{}` | Opt-in per-tool field projection: drop named noisy fields from JSON results |

### `embedding` & `billing`

`embedding.model` selects the local embedding model (`bge-small-en-v1.5` by default).
`billing` drives the savings dashboard: `mode` (`subscription` or `api`), `client` (for
client-specific tool caps), `contextWindow`, and `pricePerMTok` (API mode).

## Usage

A typical agent flow through the router:

1. **`search_tools({ intent: "open a pull request on github" })`** → the router returns the
   2–6 most relevant tools with their schemas.
2. **`call_tool({ server, name, arguments })`** → the chosen tool runs on its downstream
   server and the result comes back.
3. **`get_result({ resultId, offset })`** → only if the result was large and deferred; reads
   the remainder losslessly.

### Savings dashboard

**Every time you stop the router (`SIGINT`/`SIGTERM`), it writes a self-contained
`report.html` into `.rag-mcp/`** — an interactive dashboard of exactly what it saved that
session. Open it in any browser; no server needed.

> **▶ [Try the interactive dashboard demo](https://htmlpreview.github.io/?https://github.com/noderguru/rag-mcp-router/blob/main/docs/report-prototype.html)** — the same report, rendered live with sample data, so you can click around before installing.

It shows both savings axes — definition-side (tools not loaded into context) and result-side
(`get_result` deferrals) — in either **API** mode (`$ saved`) or **subscription** mode (freed
context / extra requests in budget), with a sortable per-tool table and what-if sliders for
price and context window. The same numbers are available live at any time via the
`get_metrics` facade tool.

### Tune with data, not vibes

```bash
pnpm bench   # labeled query set → top-1 / top-3 accuracy + MRR
```

`pnpm bench` reports retrieval quality for semantic vs hybrid vs hybrid+MMR, so you can see
whether a change actually helps before shipping it. Edit `test/eval/*.json` to benchmark
against your own tools and queries. Semantic retrieval alone is strong on small/medium
catalogs; **hybrid** earns its keep with exact identifiers or rare jargon and at larger tool
counts; **MMR** helps when near-duplicate tools crowd your results.

## Troubleshooting / FAQ

**The first run is slow / tries to download something.**
On first launch the embedding model (`bge-small-en-v1.5`) is downloaded once and cached
under `.rag-mcp/models/`. After that, retrieval is fully offline. If the download fails
(air-gapped or offline), the router degrades to a keyword fallback so it still works — just
less smart — and logs a warning on stderr.

**I edited my config and now it won't start.**
Config is validated with zod and the error message names the exact field and problem (e.g.
a server with both `command` and `url`, or neither). Fix the named field and restart.

**My client only shows 5 tools.**
That's by design — the five facade tools replace the full downstream catalog. The agent
discovers real tools at runtime via `search_tools`. (Anything listed in `retrieval.pinned`
also appears directly.)

**A downstream server is down.**
`list_servers` shows each server's status and last error. The router isolates per-server
connect failures at startup and attempts one reconnect on a failed `call_tool` before
returning a clear "server is down" error.

**A tool returned a huge blob and the agent got a preview.**
That's result optimization (`results.strategy: "spill"`). The full payload is held
server-side; the agent reads the rest with `get_result({ resultId, offset })`. Raise
`results.maxTokens` or set `strategy: "passthrough"` to disable trimming.

**Where does the router keep state?**
Everything local lives under `.rag-mcp/` (cached model, persisted index, deferred results,
`report.html`). It's gitignored. Delete it to force a clean re-embed.

## Roadmap

- [x] Walking skeleton: facade tools, downstream manager, dispatcher
- [x] Local-embeddings RAG retrieval (fastembed / bge-small) + persisted index
- [x] Dual-mode metrics: `$ saved` (API) / freed context, plan headroom (subscription)
- [x] HTML dashboard on shutdown
- [x] Hardening & DX: config validation, reconnect, unit tests + CI
- [x] Advanced retrieval: BM25 hybrid, MMR rerank, pinned tools, eval benchmark
- [x] Result optimization: lossless spill + `get_result`, result-side savings axis
- [ ] Streamable HTTP transport (remote / team)
- [ ] Profiles / allowlists (RBAC), new-tool quarantine
- [ ] Live re-index on downstream `listChanged`
- [ ] Single-binary build (bun / pkg)
- [ ] Web UI + multi-user

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup and project
layout, and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for community standards.

```bash
pnpm install
pnpm build      # tsc → dist/
pnpm test       # node:test unit suite (tsx)
pnpm smoke      # end-to-end: client → router → downstream (server-everything)
pnpm bench      # retrieval quality benchmark (needs `pnpm build` first)
```

## License

[Apache-2.0](./LICENSE)
