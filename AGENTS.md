# Agent brief — rag-mcp-router

**Before doing anything, read `HANDOFF.md` in this directory.** It is the full
context for this project: the idea, the market research (with sources), all
locked decisions, the architecture, the verified MCP SDK API, the current state
of the code, and the roadmap.

## One-paragraph what-this-is

`rag-mcp-router` is a **fully open-source (Apache-2.0) RAG router for MCP**. It
fronts all of a user's MCP servers and exposes only the *relevant* tools per
query, instead of dumping 100+ tool definitions into the agent's context. The
client sees only three facade tools — `search_tools`, `call_tool`,
`list_servers`. Status: **walking skeleton built and verified end-to-end; the
RAG core is still a keyword stub** (see `HANDOFF.md` §6–§7).

## Immediate next task

Replace the keyword stub in `src/retriever.ts` with the **local-embeddings RAG
core** (fastembed / bge-small + cosine, persisted index). That is the product's
core differentiator. Then dual-mode metrics + HTML dashboard (`HANDOFF.md` §5).

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
