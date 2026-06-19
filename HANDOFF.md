# rag-mcp-router — Handoff / Full Context

> This document is a complete brief for an agent picking up this project in a
> fresh chat. It captures the origin idea, the market research (with sources),
> all locked decisions, the architecture, the verified SDK API, the current
> state of the code, and the roadmap. Read it fully before writing code.

---

## 0. TL;DR

We are building **`rag-mcp-router`**: an open-source RAG router for the Model
Context Protocol (MCP). It sits in front of *all* of a user's MCP servers and
exposes only the **relevant** tools per query, instead of dumping every tool
definition (often 100+) into the agent's context on every request.

- **Status:** walking skeleton built and verified end-to-end. The RAG core is
  still a stub. See §6 and §7.
- **License:** Apache-2.0, fully open source, no open-core, no telemetry.
- **Stack:** TypeScript + `@modelcontextprotocol/sdk` 1.29.0 + zod, Node 22, pnpm.

---

## 1. Where this idea came from

This came out of a trend-research session (June 2026) scanning GitHub / X /
Reddit for what developers are building and complaining about. The hottest
cluster was the **MCP ecosystem**. Within it we evaluated three product ideas
and deliberately picked the least-crowded one:

| Idea | Verdict | Why |
|------|---------|-----|
| MCP server **manager / gateway / aggregator** | ❌ saturated | 17+ tools incl. IBM, Microsoft, Cloudflare, Kong, Linux Foundation |
| **Generator** REST/OpenAPI → MCP | ❌ saturated | Stainless, Speakeasy/Gram, harsha-iiiv/openapi-mcp-generator (606⭐) |
| **Token-budget profiler** | ⚠️ crowded | token-optimizer (1373⭐), ToolHive (1891⭐) |
| **RAG tool-selection router** | ✅ **open** | best existing OSS repo = fintools-ai/rag-mcp at **4⭐, abandoned** |

The RAG *tool-selection* router is the gap: the concept is documented and
research-validated, but there is **no mature open-source product**. That is what
we are building.

## 2. The problem we solve (this is the pitch)

> 5 servers × 30 tools = 150 tools ≈ **30–60K tokens** of metadata injected into
> context *before the agent does anything*.

Consequences, all documented:
- Eats **25–30% of a 200K window** just on tool definitions.
- **"Context rot"** — with too many similar tools the model picks the wrong one.
- **Hard caps** — e.g. Cursor only forwards the first **40** tools; the rest are
  silently inaccessible.
- A single well-documented tool ≈ 200–500 tokens; 50 tools ≈ 10–25K tokens.

Anthropic partially validated the approach: Claude's native tool-search loads
only relevant tools when preloaded tools exceed ~10% of the window, cutting
token use by up to **95%**. We make that universal for *any* MCP client and *any*
set of servers.

## 3. Locked decisions (do not relitigate without the user)

1. **Fully open source. NO open-core.** Metrics, dashboard, profiles, team/HTTP
   mode — all open. **Zero telemetry by default** (opt-in at most). This is a
   trust requirement for the privacy/self-hosted audience.
2. **License: Apache-2.0** (patent grant, MCP-ecosystem default, enterprise-safe).
   User explicitly chose this over MIT and AGPL.
3. **Facade-tool architecture** (the core design): the client sees only
   `search_tools(intent)` + `call_tool(server, name, arguments)` +
   `list_servers()`. The agent passes intent *explicitly* via `search_tools`
   because the router has **no access to the user's prompt** in MCP — it only
   sees tool calls. This is why we do NOT try to pre-filter `tools/list`.
4. **Local-first embeddings** (fastembed / bge-small) — no API key needed,
   private, offline, fits the self-hosted + local-AI trends.
5. **Dual-mode metric** (user's key insight — see §5).
6. **Config = drop-in `mcpServers` JSON shape** so users migrate by pasting their
   existing Cursor/Claude config and pointing the client at the router as its
   single server.
7. **SDK version strategy:** MVP on **v1.x** (`@modelcontextprotocol/sdk`,
   stable, currently 1.29.0). Design the dynamic-tools "Later" features against
   **v2 alpha** API (auto `list_changed` on `registerTool`/`RegisteredTool.update`,
   client-side `listChanged` `onChanged` callback) but don't depend on alpha yet.
8. **Distribution:** TypeScript + official MCP SDK, `npx rag-mcp-router`, aim for
   single-binary later (bun/pkg).

## 4. Architecture

The router is an MCP **server** to the client and an MCP **client** to the
downstream servers.

```
        MCP Client  (Cursor / Claude Desktop / Claude Code)
              │  one stdio/HTTP connection — sees only 3 facade tools
              ▼
┌─────────────────────────────────────────────────┐
│                  RAG-MCP ROUTER                   │
│  Facade Server (search_tools/call_tool/list_*)    │
│        │                    ▲                      │
│        ▼                    │                      │
│  Dispatcher  ◀────▶  Retriever (RAG)  ◀── Tool Index (vectors+schemas)
│        │                                  ▲        │
│        ▼                                  │ reindex on list_changed
│  Downstream Manager (MCP client) ─────────┘        │
│  Metrics / Profiler (dual-mode) → HTML dashboard   │
└─────────────────────────────────────────────────┘
              │ stdio / Streamable HTTP
      ┌───────┼────────┬─────────┐
      ▼       ▼        ▼         ▼
   github  postgres  figma  ...  srvN
```

**Components & files:**
- `src/config.ts` — load/validate config (drop-in `mcpServers` shape).
- `src/downstream.ts` — connect to N servers (stdio + Streamable HTTP), drain
  paginated `tools/list`, isolate per-server connect failures (`Promise.allSettled`).
- `src/retriever.ts` — `buildCatalog()` + `search()`. **Currently a naive keyword
  stub.** This is where the local-embeddings RAG core goes.
- `src/facade.ts` — the MCP server the client sees: registers the 3 facade tools.
- `src/dispatch.ts` — routes `call_tool` to the right downstream server,
  normalizes the result (handles legacy `{ toolResult }` shape → always returns `content`).
- `src/index.ts` — entrypoint; parses `--config`, wires everything, connects
  facade over stdio. **All logs go to stderr** (stdout is the MCP channel).

## 5. The dual-mode metric (important — not yet implemented)

The whole value framing changes depending on how the user pays. This was the
user's sharp catch and must be honored in the metrics module:

```
baseline = Σ tokens(all schemas of all downstream tools)   // life without the router
actual   = tokens(3 facade tools) + tokens(schemas surfaced via search_tools)
saved    = baseline − actual
```

| Mode (`billing.mode`) | Headline shown to user |
|---|---|
| `api` | "−78% tokens · saved $X" (saved × model price) |
| `subscription` | "freed 52K context (26% of window) · tool-selection accuracy ↑ · +N requests before plan limit · Cursor 40-tool cap bypassed" |

Rationale: most developers are on **subscriptions** (Claude Max, Cursor Pro,
Copilot), where "$ saved" is weak. For them the real value is freed context,
better tool-selection accuracy, stretching usage/rate limits, and bypassing hard
tool caps. Token counting via `tiktoken` (or Anthropic count-tokens for Claude).
Output: a single-file `report.html` regenerated on a SessionEnd hook (the pattern
that worked for token-optimizer), plus a live `get_metrics` tool.

## 6. Current state (verified)

- `pnpm build` is green.
- **End-to-end smoke test passes** (`smoke-test.mjs`, client → router →
  `@modelcontextprotocol/server-everything`):
  - client sees **only the 3 facade tools**, not the downstream's 13;
  - `search_tools('echo a message back')` surfaces `everything.echo`;
  - `call_tool(everything, echo, {message})` proxies through → `Echo: router-works`.
- Initial commit done on branch `main`. **NOT yet pushed to GitHub** (pending
  user OK — pushing is an outward-facing publish action).

Run it yourself:
```bash
pnpm install && pnpm build
node smoke-test.mjs                       # end-to-end check
# or wire into a client:
node dist/index.js --config rag-mcp.config.json
```

## 7. Roadmap (build order)

**Next (completes the MVP differentiator):**
1. **RAG core** — replace the keyword stub in `src/retriever.ts` with local
   embeddings (fastembed / bge-small) + cosine similarity; persist the index to
   `.rag-mcp/index.json`; embed each tool as
   `"{server}.{name}: {description} | params: {keys}"`.
2. **Dual-mode metrics** (§5) + `get_metrics` tool + single-file HTML dashboard
   on SessionEnd.

**Later ("Потом") — and how each maps to real SDK API:**
| Feature | SDK hook |
|---|---|
| Streamable HTTP (remote/team) | server side `NodeStreamableHTTPServerTransport({ sessionIdGenerator })` (v2 `@modelcontextprotocol/node`) |
| Live re-index of downstream | client `listChanged: { tools: { onChanged } }` (v2) |
| Pinned tools (frequent → direct) | register as real tools; toggle via `RegisteredTool.enable()/disable()` (auto `list_changed`) |
| BM25 hybrid + reranker | inside `retriever.ts`; no API impact |
| Profiles / RBAC / allowlist | filter in `search`/`dispatch`; profile from HTTP session/header |
| New-tool quarantine (supply-chain) | indexer: new downstream tool quarantined until approved |
| Web UI + multi-user | on top of HTTP mode |

## 8. Verified SDK API reference (v1.x, via context7 — saves you re-querying)

**Server (facade):**
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "rag-mcp-router", version: "0.1.0" });
server.registerTool(
  "search_tools",
  { title, description, inputSchema: { intent: z.string(), k: z.number().optional() } }, // ZodRawShape in v1.x
  async ({ intent, k }) => ({ content: [{ type: "text", text: "..." }] }),
);
await server.connect(new StdioServerTransport());
```
Note: in v1.x `inputSchema` is a **raw Zod shape** (object of fields), NOT
`z.object(...)`. (v2 alpha uses `z.object(...)` — don't mix.)

**Client (downstream):**
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name, version });
await client.connect(new StdioClientTransport({ command, args, env }));
// paginate:
let cursor; do { const r = await client.listTools(cursor ? { cursor } : {});
  tools.push(...r.tools); cursor = r.nextCursor; } while (cursor);
const res = await client.callTool({ name, arguments }); // may return legacy { toolResult }; normalize to content
```

**Gotchas already handled:**
- `client.callTool` return type is a union including a legacy `{ toolResult }`
  without `content`; `dispatch.ts` normalizes it.
- stdout must stay clean (MCP channel) — log only to stderr.
- always confirm SDK specifics via context7 before relying on v2 alpha APIs.

## 9. Sources (research trail)

Market / landscape:
- Q1 2026 MCP gateway/aggregator survey — https://www.heyitworks.tech/blog/mcp-aggregation-gateway-proxy-tools-q1-2026
- "Too many tools" / context overload — https://www.junia.ai/blog/mcp-context-window-problem ,
  https://writer.com/engineering/rag-mcp/ , https://eclipsesource.com/blogs/2026/01/22/mcp-context-overload/
- Cursor 40-tool cap & overload fixes — https://www.lunar.dev/post/why-is-there-mcp-tool-overload-and-how-to-solve-it-for-your-ai-agents
- Token optimization approaches — https://www.stackone.com/blog/mcp-token-optimization/

RAG tool-selection (the niche):
- fintools-ai/rag-mcp (4⭐, abandoned — the gap) — https://github.com/fintools-ai/rag-mcp
- Semantic tool selection guide — https://www.rconnect.tech/blog/semantic-tool-selection-guide
- SONAR (two-stage tool retrieval), NetMCP — https://arxiv.org/pdf/2510.13467

Competitors (saturated categories, for positioning):
- Generators: https://www.stainless.com/blog/generate-mcp-servers-from-openapi-specs/ ,
  https://www.speakeasy.com/blog/generate-mcp-from-openapi ,
  https://github.com/harsha-iiiv/openapi-mcp-generator (606⭐)
- Profilers: https://github.com/alexgreensh/token-optimizer (1373⭐) ,
  https://stacklok.com/blog/cut-token-waste-from-your-ai-workflow-with-the-toolhive-mcp-optimizer/ (ToolHive 1891⭐)
- Gateways: https://github.com/metatool-ai/metamcp , https://github.com/e2b-dev/awesome-mcp-gateways

SDK docs:
- MCP TypeScript SDK — https://github.com/modelcontextprotocol/typescript-sdk (use context7 `/modelcontextprotocol/typescript-sdk`)

## 10. Working agreement / conventions

- Reply to the user in **Russian**; keep code, commits, and docs in **English**.
- Conventional Commits + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Don't push to GitHub or take outward-facing actions without explicit user OK.
- Use **pnpm** (not npm).
- This is a **separate project** from the user's noderguru.dev portfolio.
```
