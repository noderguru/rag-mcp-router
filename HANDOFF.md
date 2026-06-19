# rag-mcp-router — Handoff / Full Context

> This document is a complete brief for an agent picking up this project in a
> fresh chat. It captures the origin idea, the market research (with sources),
> all locked decisions, the architecture, the verified SDK API, the current
> state of the code, and the roadmap. Read it fully before writing code.

---

## 0. TL;DR

We are building **`rag-mcp-router`**: an open-source **RAG orchestrator for the
Model Context Protocol (MCP)**. It sits in front of *all* of a user's MCP servers
(orchestrator topology: one MCP server to the client, an MCP client to N
downstream servers) and exposes only the **relevant** tools per query, instead of
dumping every tool definition (often 100+) into the agent's context on every
request.

**Positioning — be honest, the category is NOT empty (revised June 2026 after a
landscape recheck).** Dynamic/RAG tool selection is a *validated, competitive*
space, not a blue ocean. Do **not** claim "nobody has this / not even Anthropic":
- **Anthropic ships it natively** — the "Tool Search Tool", built into Claude Code
  for MCP (Jan 2026). Uses **BM25 + regex** (lexical), **Claude-only / API-side**.
- **RAG-MCP paper** (arXiv 2505.03275, May 2025) describes the exact approach.
- OSS gateways already do semantic/optimized routing: agentic-community/
  mcp-gateway-registry (FAISS + sentence-transformers, Apache-2.0, enterprise/K8s),
  abdullah1854/MCPGateway (pattern-matching + token-optimization, MIT), Stacklok
  MCP Optimizer, various "ChromaDB + MiniLM" semantic routers, mcp-spine.

**Our defensible niche is the *intersection* no single competitor covers**, and
the pitch should lead with these, not with novelty:
1. **Vendor-neutral** — any MCP client, not Claude-only (this is the strongest,
   most honest edge vs Anthropic).
2. **Semantic (embeddings)** vs Anthropic's lexical BM25.
3. **Local-first, no API key, Apache-2.0** vs enterprise/server gateways.
4. **Transparent dual-mode savings dashboard** (nice-to-have, not unique).

One-liner: *open, local-first, vendor-neutral alternative to Claude-only Tool
Search — semantic tool selection for any agent, with transparent savings.*
Still always say "RAG / semantic", never plain "aggregator".

| Plain orchestrator / aggregator | This project (RAG orchestrator) |
|---|---|
| Merges **all** tools of all servers into one list | Returns a **smart subset** per query |
| Client still sees 150 tools | Client sees 4 facade tools → then top-k relevant |
| Solves "many servers" | Solves "many **tools in context**" |

- **Status:** Phase 0 (walking skeleton) ✅ + Phase 1 (local-embeddings RAG core)
  ✅ + Phase 2 (dual-mode metrics + dashboard, commit `0d4c500`) ✅ + Phase 3
  (hardening & DX: config validation, reconnect, tests+CI, packaging, community
  docs) ✅ — built and verified end-to-end. Next: Phase 4 — Streamable HTTP
  transport (remote / team). See §6 and §7.
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
| **RAG tool-selection router** | ⚠️ **competitive (re-assessed)** | looked open in early scoping (best OSS then = fintools-ai/rag-mcp, 4⭐ abandoned), but a June 2026 recheck found real competition — see below |

**Reality check (June 2026).** This was originally picked as the *least-crowded*
idea, and at first scan it looked open. A deeper landscape search later showed it
is **validated and competitive**, not empty: Anthropic's native Tool Search
(Claude Code), the RAG-MCP paper, and several OSS gateways (mcp-gateway-registry,
MCPGateway, Stacklok Optimizer, ChromaDB+MiniLM routers). The honest framing is
not "first to do this" but "the open, local-first, **vendor-neutral**, semantic
option" — see the revised Positioning in §0. We still ship it because the
*specific intersection* (any-client + embeddings + no-API-key + Apache-2.0 +
savings transparency) is not covered by any single competitor.

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

## 2b. Compatibility — target is ANY MCP-capable harness, not just Claude Code/Cursor

Core principle: **the router is a standard MCP server; it plugs into the *client*
(the coding harness), never into the model.** The model never speaks MCP directly
— MCP is a client↔server protocol. So **the model vendor is irrelevant**: if a
tool can act as an MCP client, the router works with it unchanged (stdio today,
Streamable HTTP later).

Most new vendor coding tools converge on the same pattern: "bring our model to
Claude Code / Cursor / Cline / OpenCode / Windsurf…". The router attaches to that
harness, so it covers the whole class — dozens of harnesses, not two.

Verified June 2026:

| Tool | Is it an MCP client? | Tool limit | Works with router |
|---|---|---|---|
| **Kimi Code CLI** (Moonshot) | ✅ own CLI with MCP | none (was 128, removed Dec 2025) | ✅ yes |
| **Xiaomi MiMo Code** | ✅ own agentic CLI, MCP stdio tools; auto-imports MCP servers from Claude Code config | none | ✅ yes |
| **Z.ai GLM (devpack)** | ⤴️ a model plan applied to Claude Code / Cline / OpenCode | — | ✅ via the harness |
| **MiniMax MMX-CLI** | ❌ intentionally "MCP-free" (exposes shell commands; runs as a skill inside Claude Code/Cursor) | — | ⚠️ not into mmx-cli directly; ✅ when the MiniMax model runs inside Claude Code/Cursor |
| Claude Code, Cursor, Cline, OpenCode, Windsurf, Cherry Studio, Qwen Code, CodeBuddy, OpenClaw, … | ✅ MCP clients | see §5.2 | ✅ yes |

**Implication for value:** smaller/cheaper models suffer *more* from tool overload
and often have smaller context windows, so "surface only the 8 relevant tools"
helps them *more* than it helps frontier models. Our addressable market is the
entire MCP-harness ecosystem.

Sources: Kimi https://www.kimi.com/code/docs/en/ · MiMo https://mimo.mi.com/docs/en-US/integration/claudecode , https://github.com/KoinaAI/MiMo-CLI · Z.ai https://docs.z.ai/devpack/overview · MiniMax MMX-CLI https://www.opensourceforu.com/2026/04/minimax-open-sources-mmx-cli-for-ai-agent-workflows/

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
user's sharp catch and must be honored in the metrics module.

### 5.1 Exact formulas (pin these down in `metrics.ts`)

Notation. Let `T` = set of all downstream tools. For a tool `t`, `sch(t)` =
token count of that tool's schema **exactly as the client receives it** in the
MCP `tools/list` JSON (name + description + `inputSchema`). `facade` = token
count of the 3 facade-tool schemas (`search_tools`/`call_tool`/`list_servers`),
a constant.

**Per request** `r` (the unit that matters — compute at this granularity, never
on a session-wide union of surfaced tools):

```
baseline_r  = Σ_{t∈T} sch(t)              // life without the router: ALL schemas, every request
S_r         = tools surfaced via search_tools during request r   (deduped subset of T)
actual_r    = facade + Σ_{t∈S_r} sch(t)   // with the router: 3 facade tools + only what was surfaced
saved_r     = baseline_r − actual_r
reduction_r = saved_r / baseline_r
```

**Session** over `R` requests (aggregate by SUM, not by averaging ratios):

```
saved_session   = Σ_r saved_r
baseline_sum    = Σ_r baseline_r          // = R · baseline_r when T is stable across the session
reduction       = saved_session / baseline_sum     // the headline %  (guard R=0 / baseline=0)
```

⚠️ Do **not** define `actual` as `facade + Σ(union of all tools surfaced this
session)` — that conflates per-request cost with the session and understates the
win. The prototype dashboard does this only because its mock `surfaced` set is
fixed; real accounting is per-request as above.

### 5.2 Mode headlines

Inputs are split into **measured** (from the running router) and **assumed**
(defaults from config, optionally explored via the report's what-if sliders):

- *Measured*: `sch(t)`, `facade`, `S_r` per request, `R`, per-tool call counts.
- *Assumed (config defaults)*: `pricePerMTok` ← `billing.pricePerMTok`,
  `contextWindow` ← `billing.contextWindow`. The report may slide these for
  what-if, but they must **start** from config and never masquerade as measured.

```
# api mode
$saved = (saved_session input tokens / 1e6) · pricePerMTok
  ⚠️ caching caveat: if the client caches tool definitions, the effective rate is
     the cache-read price (~10× cheaper). Default headline assumes UNCACHED (upper
     bound) and must say so; optional billing.cachedInputPerMTok for the cached estimate.

# subscription mode
freed_per_req   = mean_r(saved_r)                 // or saved_session / R
freed_pct_window = freed_per_req / contextWindow  // "% of window reclaimed per request"
extra_requests  ≈ saved_session / mean_r(actual_r)   // "~N more router-sized requests within the freed budget" — ESTIMATE, label it
cap_bypassed    = show ONLY if billing.client maps to a client with a HARD tool cap
                  AND |T| > cap; message: "<|T|> tools behind 3 facade tools — <client> <cap>-tool cap bypassed"
```

**Verified client tool caps (June 2026 — confirm before relying):**

| `billing.client` | Hard cap | Notes |
|---|---|---|
| `cursor` | **40** | Sends only the first 40 tools across ALL MCP servers to the model |
| `vscode` / `copilot` | **128** | Hard cap at request time ("may not include more than 128 tools"); has auto-grouping "virtual tools" above a threshold |
| `claude-code` | none (soft) | Bounded by context window; ships built-in **MCP Tool Search** (defers tool defs, loads on demand — same idea as us, but Claude-only) |
| `codex` (OpenAI CLI) | none documented | Best-practice guidance only (context pollution) |
| `kimi-code` (MoonshotAI) | none (soft) | **Previously 128** — removed Dec 2025 by MoonshotAI staff. Now unlimited tools, constrained only by token context (256K for K2.5). Confirmed in forum and in source (no MAX_TOOLS / slice in `packages/agent-core/src/mcp/`). |
| `mimo-code` (XiaomiMiMo) | none (soft) | No hard cap. Confirmed in source: `packages/opencode/src/mcp/index.ts` — `tools()` iterates all tools from all connected clients without capping or truncation. Fork of OpenCode, inherits same unlimited approach. |

So `cap_bypassed` fires for `cursor`/`copilot`; for `claude-code`/`codex`/`kimi-code`/`mimo-code`
lead with the freed-context / accuracy framing instead (no hard cap to "bypass"). Sources: §9.

| Mode (`billing.mode`) | Headline |
|---|---|
| `api` | "−`reduction`% tokens · saved $`$saved`" |
| `subscription` | "freed `freed_per_req` (`freed_pct_window` of window) · +`extra_requests` requests in budget · `cursor_cap`" |

Rationale: most developers are on **subscriptions** (Claude Max, Cursor Pro,
Copilot), where "$ saved" is weak. For them the real value is freed context,
better tool-selection accuracy, stretching usage/rate limits, and bypassing hard
tool caps.

### 5.3 Implementation notes

- **Token counting:** `tiktoken` (cl100k/o200k) **locally by default** — offline,
  no API key (fits the local-first principle). Optional exact mode via Anthropic
  `count_tokens` for Claude (network, opt-in). Count `sch(t)` over the serialized
  `tools/list` entry, not a hand-rolled string.
- **Output:** a single self-contained `report.html` regenerated on a SessionEnd
  hook (the token-optimizer pattern), plus a live `get_metrics` facade tool.
- **Prototype already exists:** `docs/report-prototype.html` — editorial design,
  dual-mode tabs, dark/light, what-if sliders (price/window only), measured-vs-
  assumed split, sortable tool table. Phase 2 = wire real metrics into this shape.

## 6. Current state (verified)

- `pnpm build` is green.
- **End-to-end smoke test passes** (`smoke-test.mjs`, client → router →
  `@modelcontextprotocol/server-everything`) — all 7 steps:
  - [1] client sees **4 facade tools** (`search_tools`, `call_tool`, `list_servers`, `get_metrics`);
  - [2] `list_servers` returns connected servers and tool counts;
  - [3] `search_tools('echo a message back')` surfaces `everything.echo`;
  - [4] `call_tool(everything, echo, {message})` proxies through → `Echo: router-works`;
  - [5] **semantic retrieval:** `search_tools('show me a small picture')`
    returns `everything.get-tiny-image` on top despite zero keyword overlap;
  - [6] **`get_metrics`** returns valid snapshot (requests, baseline, facade, saved, perToolCalls);
  - [7] **`report.html`** generated on shutdown with live data (real tool names, not mock).
  - Index persists to `.rag-mcp/index.json` and reloads without re-embedding.
- **Dashboard** (`docs/report-prototype.html` + `src/report.ts`): editorial
  design, Subscription/API tabs, dark/light toggle, what-if sliders (price/window),
  measured-vs-assumed split, sortable+expandable tool table, GitHub author link.
  Now wired to live metrics — generated as `.rag-mcp/report.html` on shutdown.
- All work on branch `main`, **committed but NOT pushed** (pending user OK — pushing
  is an outward-facing publish action).

Run it yourself:
```bash
pnpm install && pnpm build
node smoke-test.mjs                       # end-to-end check
# or wire into a client:
node dist/index.js --config rag-mcp.config.json
```

## 7. Detailed implementation plan (track progress here)

> **How to use this:** check off `[x]` each task as it lands; keep the "Status"
> line of each phase current. Each phase has **acceptance criteria** — don't mark
> a phase done until they pass. Phases are ordered by dependency. Phases 1–2 are
> the MVP that proves the differentiator; ship/announce after Phase 3.

### Phase 0 — Walking skeleton ✅ DONE
Status: complete (commit `999178d`). Verified end-to-end (§6).
- [x] Project scaffold (TS, pnpm, tsconfig, Apache-2.0 LICENSE, .gitignore)
- [x] `config.ts` — load/validate drop-in `mcpServers` config
- [x] `downstream.ts` — connect N servers (stdio+HTTP), paginate `tools/list`, isolate failures
- [x] `facade.ts` — 3 facade tools (`search_tools`/`call_tool`/`list_servers`)
- [x] `dispatch.ts` — proxy + result normalization
- [x] `retriever.ts` — keyword **stub**
- [x] `index.ts` — stdio entrypoint, stderr-only logging
- [x] `smoke-test.mjs` — end-to-end check passes

### Phase 1 — RAG core (THE differentiator) ✅ DONE
Status: complete. Keyword stub replaced with local-embeddings semantic retrieval.
Verified end-to-end (`smoke-test.mjs` step [5]).
- [x] Add `fastembed` dep (2.1.0); lazy-load `bge-small-en-v1.5` (download once, cache under `.rag-mcp/models`)
- [x] `src/index/embed.ts` — `Embedder`: `embedDocuments` (passageEmbed) / `embedQuery` (queryEmbed); exposes `dimension`. Vectors coerced to plain `number[]` via `Array.from` so they survive JSON persistence (fastembed yields `Float32Array`, which serializes to an object). Creates `cacheDir` recursively (fastembed's own mkdir is non-recursive).
- [x] `src/index/store.ts` — `VectorStore`: in-memory normalized vectors + cosine (dot); persist/load `.rag-mcp/index.json` with version + hash invalidation
- [x] Tool → document: `"{server}.{name}: {description} | params: {param keys}"` (`toDocument` in `retriever.ts`)
- [x] `retriever.ts` — `buildRetriever()` returns `SemanticRetriever` (embed query → cosine → top-k); `KeywordRetriever` kept as graceful fallback when the embedder can't init (offline/missing model). `search()` is now async.
- [x] Index invalidation: `catalogHash(model, docs)` (sha256) — mismatch ⇒ re-embed
- [x] First-run UX: download progress to **stderr** (verified: `progress` pkg defaults to stderr, fastembed only `console.warn`s)
- [x] Extend `smoke-test.mjs`: step [5] asserts "show me a small picture" → `get-tiny-image` top (no keyword overlap → also proves semantic mode is active, not the keyword fallback)
- [x] `package.json` `pnpm.onlyBuiltDependencies: [onnxruntime-node]` for clean installs

**Acceptance:** ✅ `search_tools("<intent with no exact keyword>")` returns the correct tool in top-k (e.g. "show me a small picture" → get-tiny-image @ 0.78); ✅ index persists and reloads without re-embedding (re-run logs "loaded persisted index"); ✅ no network calls / no API key at runtime once the model is cached.

### Phase 2 — Dual-mode metrics + dashboard ✅ DONE
Status: complete. Per-request metrics accounting (§5.1) wired into the router;
live `report.html` generated on shutdown. Verified end-to-end (`smoke-test.mjs`
steps [6]–[7]).
- [x] Dashboard UI prototype: `docs/report-prototype.html` (editorial design,
  dual-mode tabs, dark/light, what-if sliders for price/window, measured-vs-
  assumed split, sortable/expandable tool table). Mock data only.
- [x] Add `js-tiktoken` for local token counting (offline default, cl100k_base)
- [x] `src/metrics.ts` — **per-request** accounting per §5.1: `baseline_r`, `facade`, `S_r`, `saved_r`; aggregate to session by sum. Guard R=0.
- [x] Mode switch on `billing.mode`: `api` → `$ saved` (note caching caveat §5.2); `subscription` → freed context (tokens + % window), est. extra requests, cap flag gated on `billing.client`
- [x] `get_metrics` facade tool (live read) — 4th facade tool
- [x] `src/report.ts` — render the prototype from live metrics → single-file `report.html` in `.rag-mcp/`. Generated on SIGINT/SIGTERM.
- [ ] **Deferred:** inline/subset web fonts for offline use (prototype currently pulls Google Fonts via CDN — editorial fonts are ~200KB; low priority for MVP)
- [x] Regenerate report on shutdown (SIGINT/SIGTERM handlers in `index.ts`)

**Acceptance:** ✅ after a session, `report.html` shows correct numbers in BOTH
modes (flip `billing.mode` in config and re-run); ✅ subscription mode never
shows `$`; ✅ per-request accounting matches §5.1; ✅ `get_metrics` returns valid
snapshot; ✅ 0 console errors in browser; ⚠️ offline use deferred (fonts via CDN).

### Phase 3 — Hardening & DX (ship after this) ✅ DONE
Status: complete. Validation, reconnect, tests+CI, packaging, and community docs
all landed and verified (`pnpm build && pnpm test` green; `pnpm smoke` passes).
- [x] Config schema validation with clear errors (zod over the config file) — `src/config.ts`: strict schemas, defaults, path-prefixed messages; rejects empty `mcpServers`, command/url XOR, unknown keys, bad JSON, missing file
- [x] Graceful downstream reconnect / surfacing of dead servers in `list_servers` — `Conn.status`/`lastError`; failed servers kept as dead placeholders; `dispatch` reconnects on demand; `client.onclose` marks disconnected
- [x] Unit tests (retriever ranking, dispatch normalization, metrics math, config validation) + CI — `test/*.test.ts` (27 tests, `node:test` via `tsx`); `.github/workflows/ci.yml` builds+tests on Node 20 & 22
- [x] `npx rag-mcp-router` works from a clean install; README quickstart verified — `files` now ships `docs/report-prototype.html`; `pnpm pack` confirmed contents + shebang; README rewritten (npx-first, status, dev section)
- [x] CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue templates (bug/feature + config), PR template

**Acceptance:** ✅ `pnpm build && pnpm test` green; CI runs the same on Node 20/22; ✅ `npx rag-mcp-router --config …` runs from the packed tarball; a new user goes from clone → working router against one real server in <5 min.

### Phase 4 — Streamable HTTP transport (remote / team) ⬜
- [ ] Server transport — **SDK recon done (June 2026): use stable v1.x
  `StreamableHTTPServerTransport({ sessionIdGenerator })` from
  `@modelcontextprotocol/sdk/server/streamableHttp.js`** (verified: imports +
  constructs on installed v1.29.0; `@hono/node-server` resolves transitively).
  Do NOT switch to the v2-alpha `NodeStreamableHTTPServerTransport` /
  `@modelcontextprotocol/node` — same `sessionIdGenerator` API, no need.
- [ ] `--http <port>` flag; keep stdio default
- [ ] Per-session isolation — shared (downstream conns, retriever/index), per-session
  (a fresh `McpServer` facade + its own `Metrics`) in a `Map<sessionId, …>`
- [ ] Default bind 127.0.0.1 (no auth); network exposure / tokens deferred to Phase 6
**Acceptance:** a remote MCP client connects over HTTP and runs the full search→call flow.
**Note:** Phase 4 is *optional* — only needed for web/hosted clients (can't spawn a
local process), remote/containerized deploys, or one shared router for a team.
For a single local developer, stdio already covers everything; skip if not needed.

### Phase 5 — Advanced retrieval ✅ DONE
Status: complete. Hybrid + MMR + pinned tools + eval benchmark, verified
(`pnpm test` 39 units, `pnpm smoke` step [8], `pnpm bench`).
- [x] BM25 lexical index (`src/index/bm25.ts`); hybrid score = α·cosine + β·bm25, min-max normalized, configurable (`retrieval.hybrid/alpha/beta`), wired in `RagRetriever`
- [x] Optional rerank of top-N — **MMR** (relevance-vs-diversity over existing embeddings, `src/index/rerank.ts`), `retrieval.rerank/rerankLambda/candidates`, default off. (fastembed 2.1 has no cross-encoder; a neural reranker is a documented future backend — MMR is the dependency-free default.)
- [x] Pinned tools: `retrieval.pinned: ["server.name"]` → `registerPinned` (`src/pinned.ts`) exposes them directly via `registerTool` (JSON-Schema→Zod shallow converter); counted as constant overhead in metrics
- [x] Eval benchmark: `test/eval/{catalog,queries}.json` + `test/eval/run.mjs` (`pnpm bench`) — top-1/top-3/MRR for semantic vs hybrid vs hybrid+MMR
**Acceptance:** ✅ measurable: benchmark in place comparing modes; ✅ pinned tools callable without `search_tools` (smoke [8]). **Finding:** at small/medium catalog size semantic alone is already strong (top-3 ≈100% on the eval set); hybrid is neutral-to-positive (pays off on exact-term queries / large catalogs), MMR trades top-k precision for diversity → correctly default-off. Re-run `pnpm bench` before tuning.

### Phase 6 — Profiles / RBAC / supply-chain ⬜
- [ ] Named profiles (per client/project) with tool allow/deny lists; filter in `search` + `dispatch`
- [ ] New-tool **quarantine**: a newly appearing downstream tool is not indexed/callable until approved
**Acceptance:** a quarantined tool is invisible to `search_tools` and rejected by `call_tool` until approved.

### Phase 7 — Live re-index ⬜
- [ ] Client-side `listChanged: { tools: { onChanged } }` (v2) → re-embed only changed server
**Acceptance:** adding a tool to a running downstream server updates results without restart.

### Phase 8 — Distribution & launch ⬜
- [ ] Publish to npm; semver; CHANGELOG
- [ ] Single-binary build (bun/pkg)
- [ ] Launch post + demo (the "60K → 8K" before/after); submit to awesome-mcp lists
**Acceptance:** `npx rag-mcp-router@latest` runs; repo public with README/badges.

### Phase 9 — Web UI + multi-user ⬜
- [ ] Web dashboard (metrics, server/profile management) on top of HTTP mode
**Acceptance:** manage servers and view metrics from a browser.

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

Client tool caps (verified June 2026 — see §5.2 table):
- Cursor 40-tool cap — https://forum.cursor.com/t/mcp-server-40-tool-limit-in-cursor-is-this-frustrating-your-workflow/81627 , https://github.com/cursor/cursor/issues/3369
- VS Code / Copilot 128-tool hard cap (+ virtual tools) — https://github.com/microsoft/vscode/issues/290356 , https://code.visualstudio.com/docs/copilot/agents/agent-tools
- Claude Code: no hard cap, built-in MCP Tool Search (defers tool defs) — https://code.claude.com/docs/en/mcp , https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide
- Codex CLI: no documented numeric cap, best-practice guidance — https://developers.openai.com/codex/config-reference
- Kimi Code: 128-tool limit removed Dec 2025; now unlimited (256K context) — https://forum.moonshot.ai/t/my-onboarding-experience-and-questions-so-far/124/6 , https://github.com/MoonshotAI/kimi-code (code: no MAX_TOOLS in `packages/agent-core/src/mcp/`)
- MiMo-Code: no hard cap; all tools forwarded — https://github.com/XiaomiMiMo/MiMo-Code (code: `packages/opencode/src/mcp/index.ts` — `tools()` iterates without capping)

RAG tool-selection (the niche):
- fintools-ai/rag-mcp (4⭐, abandoned) — https://github.com/fintools-ai/rag-mcp
- Semantic tool selection guide — https://www.rconnect.tech/blog/semantic-tool-selection-guide
- SONAR (two-stage tool retrieval), NetMCP — https://arxiv.org/pdf/2510.13467

Competitive landscape recheck (June 2026 — this niche is NOT empty):
- Anthropic Tool Search Tool (BM25/regex, Claude-only, in Claude Code) —
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool ,
  https://tessl.io/blog/anthropic-brings-mcp-tool-search-to-claude-code/
- RAG-MCP paper (semantic MCP tool retrieval, −50% tokens) — https://arxiv.org/abs/2505.03275
- agentic-community/mcp-gateway-registry (FAISS + sentence-transformers, hybrid RRF,
  Apache-2.0, enterprise/K8s) — https://github.com/agentic-community/mcp-gateway-registry
- abdullah1854/MCPGateway (pattern-matching + token-optimization layers, MIT) —
  https://github.com/abdullah1854/MCPGateway
- Stacklok MCP Optimizer (team token-waste reduction) —
  https://stacklok.com/blog/cut-token-waste-across-your-entire-team-with-the-mcp-optimizer/
- Donnyb369/mcp-spine (local-first context minifier proxy) — https://github.com/Donnyb369/mcp-spine
- awesome-mcp-gateways (list) — https://github.com/e2b-dev/awesome-mcp-gateways

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
