# Agent brief — rag-mcp-router

**Before doing anything, read `HANDOFF.md` in this directory.** It is the full
context for this project: the idea, the market research (with sources), all
locked decisions, the architecture, the verified MCP SDK API, the current state
of the code, and the roadmap.

## One-paragraph what-this-is

`rag-mcp-router` is a **fully open-source (Apache-2.0) RAG orchestrator for MCP**.
It fronts all of a user's MCP servers (orchestrator topology) and exposes only
the *relevant* tools per query, instead of dumping 100+ tool definitions into the
agent's context. The client sees only three facade tools — `search_tools`,
`call_tool`, `list_servers`. **Positioning:** describe it as a *RAG / semantic*
orchestrator, never a plain "aggregator" (that category is saturated — the RAG
tool-selection layer is the differentiator). It works with **any MCP-capable
harness** (Claude Code, Cursor, Cline, OpenCode, Kimi Code, Xiaomi MiMo, etc.),
not just Claude Code/Cursor — the model vendor is irrelevant. Status: **walking
skeleton + local-embeddings RAG core built and verified end-to-end**
(see `HANDOFF.md` §6–§7, plan in §7).

## Immediate next task

Phase 1 (local-embeddings RAG core) is **done and verified** — `src/retriever.ts`
now does semantic retrieval (fastembed / bge-small + cosine, persisted index),
with a keyword fallback. Next up is **Phase 2: dual-mode metrics + HTML
dashboard** (`HANDOFF.md` §5 and §7 Phase 2).

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
