# cursor-harness

A/B comparison: run a task with Cursor CLI (`agent`) with and without Unblocked context, then compare results.

## Running

```bash
bun start -- --repo /path/to/repo --task "implement feature X"
```

Set `CURSOR_BINARY` env var to override binary name (default: `agent`).

## Architecture

- `src/cursor.ts` — Spawn Cursor CLI, parse stream-json, manage worktrees, contamination detection
- `src/runner.ts` — Orchestrate: disable MCP, sequential arm execution, diff capture, comparison
- `src/report.ts` — Console + HTML + JSON comparison reports
- `src/util.ts` — Token pricing, formatting helpers
- `src/types.ts` — Shared type definitions

## Conventions

- Bun + TypeScript, no build step
- Use `bun <file>` not `node <file>`
- Error handling: throw on unrecoverable, log + continue on per-run failures
