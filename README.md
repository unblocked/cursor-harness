# cursor-harness

Local A/B comparison tool that measures what [Unblocked](https://getunblocked.com) adds to Cursor's coding agent.

Runs the same task twice through Cursor CLI (`agent`) — once without Unblocked context, once with — and produces a structured comparison of cost, time, and code changes.

## How it works

1. **Disable Unblocked MCP** for both arms (ensures clean baseline)
2. **Run A (Baseline):** Cursor agent with a nudge blocking all Unblocked tools/CLI/skills
3. **Run B (With Unblocked):** Cursor agent with a nudge to call `unblocked context-research` via CLI before coding
4. **Report:** Deterministic metrics (tokens, cost, time, tool calls, diff stats) in console + HTML + JSON

Both runs use Cursor-managed worktrees branched from the same commit. No manual git setup required.

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Cursor CLI](https://cursor.com) (`agent` binary in your PATH)
- [Unblocked CLI](https://getunblocked.com) (`unblocked` binary in your PATH, authenticated)

## Setup

```bash
git clone <repo-url>
cd cursor-harness
bun install
```

Set `CURSOR_BINARY` if your Cursor CLI binary is not named `agent`:

```bash
export CURSOR_BINARY=cursor-agent
```

That's it. No API keys needed — Cursor handles model auth, Unblocked CLI handles its own auth.

## Running a comparison

Point the tool at any local repository and give it a task:

```bash
bun start -- \
  --repo /path/to/your/app \
  --task "Add rate limiting to the /api/webhooks endpoint"
```

Results are written to a timestamped directory under `results/`.

### CLI options

| Flag | Description | Default |
|---|---|---|
| `--repo <path>` | Path to the local repository to work on | Required |
| `--task <string>` | Engineering task for the agent to perform | Required |
| `--model <model>` | Model identifier (e.g. `claude-opus-4-7`, `gpt-4o`) | `claude-opus-4-7` |
| `--timeout <seconds>` | Max seconds per arm | `3600` |
| `--branch <name>` | Git branch to base worktrees on | Current HEAD |
| `--keep-worktrees` | Don't clean up worktrees after run | `false` |

## Output

Each run produces a timestamped directory under `results/`:

```
results/run-2026-05-26T15-52-09/
  baseline/
    baseline.jsonl        # Raw stream-json output from Cursor
  unblocked/
    unblocked.jsonl       # Raw stream-json output from Cursor
  result.json             # Machine-readable comparison metrics
  report.html             # Visual comparison report
```

### Metrics captured

| Metric | How it is measured |
|---|---|
| Wall-clock time | `Date.now()` delta in the harness |
| Input/output tokens | From Cursor's stream-json `result` events (exact) |
| Cache read/write tokens | From Cursor's stream-json `result` events (exact) |
| Estimated cost | Tokens x Cursor's published per-token rates (computed) |
| Tool call count | Parsed from stream-json `tool_call` events (exact) |
| Unblocked query count | Filtered from CLI shell calls (exact) |
| Git diff stats | Files changed, lines added/removed from worktree diff |
## Supported models

Any model available in Cursor that supports tool use. Cost estimation is available for:

| Model | Input $/M | Output $/M |
|---|---|---|
| `claude-opus-4-7` | $5 | $25 |
| `claude-sonnet-4-6` | $3 | $15 |
| `claude-sonnet-4-5` | $3 | $15 |
| `claude-haiku-4-5` | $1 | $5 |
| `gpt-4o` | $2.50 | $10 |
| `gpt-4.1` | $2 | $8 |
| `o3` | $10 | $40 |

Unlisted models still work — cost is reported as $0.

## Troubleshooting

**"Unable to resolve git repository"** — The `--repo` path must be a git repository. Run `git status` in the target directory to verify.

**"agent: command not found"** — Cursor CLI is not in your PATH. Set `CURSOR_BINARY` to the full path, or add its directory to PATH.

**Worktree cleanup failures** — If worktrees are left behind after a crash, clean up with `git worktree list` and `git worktree remove <path>` in the target repo.

**Timeout** — Default is 60 minutes per arm. Increase with `--timeout 7200` for complex tasks.

## License

MIT
