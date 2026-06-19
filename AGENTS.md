# Agent brief — rag-mcp-router

**Before doing anything, read `HANDOFF.md` in this directory.** It is the full
context for this project: the idea, the market research (with sources), all
locked decisions, the architecture, the verified MCP SDK API, the current state
of the code, and the roadmap.

## One-paragraph what-this-is

`rag-mcp-router` is a **fully open-source (Apache-2.0) RAG orchestrator for MCP**.
It fronts all of a user's MCP servers (orchestrator topology) and exposes only
the *relevant* tools per query, instead of dumping 100+ tool definitions into the
agent's context. The client sees four facade tools — `search_tools`, `call_tool`,
`list_servers`, `get_metrics`. **Positioning (honest, June 2026 recheck):** this
niche is **competitive, not empty** — Anthropic ships a native Tool Search
(BM25/regex, Claude-only) and OSS gateways do semantic routing too. Do NOT claim
novelty ("nobody/Anthropic doesn't have this"). Lead with the defensible
intersection: **vendor-neutral** (any MCP harness — Claude Code, Cursor, Cline,
OpenCode, Kimi, MiMo…, not Claude-only), **semantic embeddings** (vs lexical
BM25), **local-first / no API key**, Apache-2.0, transparent savings. Always say
"RAG / semantic", never plain "aggregator". Status: **Phases 0–3 done**
(RAG core + dual-mode metrics + hardening/DX), verified end-to-end; next is
Phase 4 (Streamable HTTP). See `HANDOFF.md` §0–§1 (positioning) and §6–§7.

## Immediate next task

Phases 1–3 and **5** are **done and verified**: semantic RAG core
(`src/retriever.ts`), dual-mode metrics + HTML dashboard, hardening/DX (zod
validation, reconnect + status, unit tests + CI, npx packaging, community docs),
and advanced retrieval (BM25 hybrid, MMR rerank, pinned tools, `pnpm bench` eval).
**Phase 4 (Streamable HTTP) is intentionally skipped** for now — it's optional
(only for web/hosted clients, remote deploys, or a shared team router; a single
local dev needs only stdio). SDK recon is recorded in `HANDOFF.md` §7 Phase 4 if
it's ever picked up (use stable v1.x `StreamableHTTPServerTransport`, not v2-alpha).
Remaining roadmap: Phase 6 (profiles/RBAC), Phase 7 (live re-index), Phase 8
(distribution/launch). Pick with the user — no work is in flight.

## Hard rules

- Reply to the user in **Russian**; keep code/commits/docs in **English**.
- Use **pnpm**, not npm.
- **No telemetry, no open-core** — everything stays open.
- Don't push to GitHub or take outward-facing actions without explicit user OK
  (the initial commit exists locally on `main`, not yet pushed).
- Verify MCP SDK specifics via context7 (`/modelcontextprotocol/typescript-sdk`)
  before relying on v2-alpha APIs; the MVP is on stable v1.x.

## Run / verify

```bash
pnpm install && pnpm build
node smoke-test.mjs              # end-to-end: client -> router -> downstream
```
