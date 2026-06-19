# Contributing to rag-mcp-router

Thanks for your interest in improving rag-mcp-router! This is a fully
open-source (Apache-2.0) project — no open-core, no telemetry. Contributions of
all sizes are welcome.

## Getting started

Requirements: **Node ≥ 20** and **pnpm** (we use pnpm, not npm).

```bash
git clone https://github.com/<your-fork>/rag-mcp-router
cd rag-mcp-router
pnpm install
pnpm build
```

## Development workflow

```bash
pnpm build      # tsc → dist/   (also typechecks)
pnpm test       # node:test unit suite (run via tsx)
pnpm smoke      # end-to-end: client → router → @modelcontextprotocol/server-everything
pnpm dev        # tsc --watch
```

Before opening a PR, make sure both **`pnpm build`** and **`pnpm test`** are
green — CI runs exactly these on Node 20 and 22.

### Running the router locally

```bash
cp rag-mcp.config.example.json rag-mcp.config.json   # point it at your servers
node dist/index.js --config rag-mcp.config.json
```

The first run downloads the embedding model once into `.rag-mcp/` (gitignored);
retrieval is offline after that.

## Project layout

| Path | What it is |
|------|-----------|
| `src/config.ts` | Config loading + zod validation |
| `src/downstream.ts` | Connect to / reconnect downstream MCP servers |
| `src/dispatch.ts` | Proxy a `call_tool` to the right server, normalize results |
| `src/facade.ts` | The 4 facade tools the client sees |
| `src/retriever.ts` | Semantic (and keyword-fallback) tool retrieval |
| `src/index/` | Embedder + vector store |
| `src/metrics.ts` / `src/report.ts` | Token accounting + HTML dashboard |
| `test/` | `node:test` unit tests |

## Guidelines

- **Keep stdout clean.** stdout is the MCP protocol channel — all logging goes to
  **stderr** (`console.error`).
- **Local-first.** Don't add runtime dependencies on network services or API
  keys for core functionality.
- **No telemetry, ever.**
- **Match the surrounding style** — TypeScript strict mode, ESM, `.js`
  import specifiers (NodeNext resolution).
- **Add a test** for new logic where practical; tests must not require network
  access or downloading models.
- Write code, comments, and commit messages in **English**.

## Submitting changes

1. Fork and create a topic branch.
2. Make your change with a focused commit history.
3. Ensure `pnpm build && pnpm test` pass.
4. Open a PR describing **what** changed and **why**. Link any related issue.

By contributing, you agree your contributions are licensed under the project's
[Apache-2.0](LICENSE) license. Please also follow our
[Code of Conduct](CODE_OF_CONDUCT.md).
