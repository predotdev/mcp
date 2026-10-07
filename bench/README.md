# Benchmark: Claude in Chrome vs the pre.dev MCP

The harness and results behind the post [*We made Claude Code 2x faster in Chrome*](https://pre.dev/blog/we-made-claude-code-2x-faster-in-chrome/) on the pre.dev blog.

One agent, two sets of browser tools. Every run is a `claude -p` session on Claude Sonnet 5.5 with no CLAUDE.md or user settings (`--setting-sources local`) and exactly one set of browser tools. The prompt is identical for both sides and names no Chrome profile: `Use only your browser tools.` followed by the task.

| Side | How it's loaded |
| --- | --- |
| `claude-in-chrome` | `claude --chrome` (the Claude in Chrome extension, signed in to the same Claude account) |
| `predev-mcp` | `--mcp-config` with `@predotdev/mcp` |

Two setups:

| Setup | Claude Code's built-in tools | pre.dev MCP |
| --- | --- | --- |
| `everyday` | on, except WebFetch, WebSearch and Bash (so the agent can't go around the browser) | as `setup` installs it, cloud tools included |
| `browser-only` | off (`--tools ""`) | Chrome tools only (`PREDEV_MCP_CLOUD=off`) |

8 public, read-only tasks, 3 runs each per side, sides alternating. A script checks each answer (live values from the Hacker News, GitHub and npm APIs; fixed values for the rest).

## Results (October 7, 2026)

Claude Code 2.1.292, Claude Sonnet 5.5, Claude in Chrome extension 1.0.98, `@predotdev/mcp` 2.0.2. Every run passed on both sides. Ratios are the median of the 8 per-task ratios; totals add up all 24 runs per side.

| pre.dev MCP vs Claude in Chrome | Everyday | Browser tools only |
| --- | --- | --- |
| Faster per task | 2.0x | 1.8x |
| Fewer tokens per task | 1.4x | 2.3x |
| Cheaper per task (API list prices) | 1.8x | 2.1x |
| Total time | 726 s vs 369 s | 536 s vs 315 s |
| Total cost | $2.47 vs $1.28 | $0.74 vs $0.45 |

- `results-everyday.jsonl`, `results.jsonl` (browser-only): one row per run with task, side, repetition, time, tokens, cost, tool calls by name (and actions inside a `browser_batch`), the answer and its check.
- `summary*.json`: per-task medians and per-side totals (`python3 analyze.py`, `BENCH_SETUP=everyday python3 analyze.py`).
- `deep*.json`: context size per model call, tool mix and tool result sizes (`deep.py`, from the per-run logs, which aren't included).

## Run it yourself

You need Claude Code signed in with a paid Claude plan, the Claude in Chrome extension signed in to the same account, Chrome with remote debugging on (`chrome://inspect/#remote-debugging`), and Node.js 22.

```bash
mkdir -p /tmp/bench && cd /tmp/bench
echo '{"mcpServers":{}}' > empty-mcp.json
echo '{"mcpServers":{"predev":{"command":"npx","args":["-y","@predotdev/mcp@2.0.2"],"env":{"PREDEV_MCP_CLOUD":"off"}}}}' > predev-mcp.json
echo '{"mcpServers":{"predev":{"command":"npx","args":["-y","@predotdev/mcp@2.0.2"]}}}' > predev-mcp-cloud.json
cd -   # back to this folder
BENCH_SCRATCH=/tmp/bench BENCH_SETUP=everyday BENCH_RESULTS=my-everyday.jsonl python3 bench.py run 3
BENCH_SCRATCH=/tmp/bench BENCH_RESULTS=my-browser-only.jsonl python3 bench.py run 3
```

The harness closes only tabs it opened: tabs that weren't there when it started and are on one of the 8 test sites. Without a pre.dev key the server still works; the agent just can't use the plain-words `chrome_act`.
