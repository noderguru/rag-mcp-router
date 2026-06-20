# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-20

### Added
- **`init` subcommand** — `npx rag-mcp-router init` scaffolds a starter
  `rag-mcp.config.json` in the current directory (never overwrites an existing one),
  so onboarding is a single command. Also added `--help`.
- **README**: prominent savings-dashboard section with a link to an interactive demo
  of the report, and clearer docs that a `report.html` is written on shutdown.

## [0.1.0] - 2026-06-20

First public release. A local-first, vendor-neutral RAG router for the Model
Context Protocol: put it in front of all your MCP servers and it exposes only the
relevant tools per query instead of dumping every tool definition into the agent's
context.

### Added
- **Facade server** — the client sees five tools instead of the full downstream
  catalog: `search_tools`, `call_tool`, `get_result`, `list_servers`, `get_metrics`.
- **Local-embeddings RAG retrieval** — `fastembed` / `bge-small-en-v1.5`, no API key,
  fully offline after the one-time model download. Persisted vector index keyed by a
  catalog hash, so an unchanged tool set reloads without re-embedding.
- **Advanced retrieval** — hybrid lexical (BM25) + semantic (cosine) blend with
  configurable `alpha`/`beta`, optional MMR reranking for relevance-vs-diversity, and
  `pinned` tools exposed directly without `search_tools`.
- **Result optimization (Phase R)** — large tool results are trimmed before they enter
  context. Default `spill` strategy is lossless: oversized results are stored whole and
  replaced with a preview + a `resultId`, with the remainder fetched on demand via
  `get_result`. Opt-in `truncate` strategy and per-tool `dropFields` projection. New
  `results` config block (`maxTokens`, `strategy`, `store`, `ttlSeconds`, `dropFields`).
- **Dual-mode metrics + dashboard** — per-request token accounting in API (`$ saved`)
  and subscription (freed context / plan headroom) modes, with a second result-side
  savings axis (`resultTokensDeferred`). A self-contained `report.html` is written on
  shutdown.
- **Downstream transport** — stdio and Streamable HTTP downstream servers, paginated
  `tools/list` draining, per-server connect isolation, and graceful reconnect.
- **DX & hardening** — zod config validation with readable errors, unit-test suite +
  CI (Node 20 & 22), an end-to-end smoke test, and a retrieval-quality benchmark
  (`pnpm bench`).

[Unreleased]: https://github.com/noderguru/rag-mcp-router/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/noderguru/rag-mcp-router/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/noderguru/rag-mcp-router/releases/tag/v0.1.0
