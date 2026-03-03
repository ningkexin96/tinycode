# TinyCode

**A minimal but complete Coding Agent Harness — built on [Pi](https://github.com/earendil-works/pi).**

```
TinyCode

Model + Agent Loop + Tools + Permissions + Session
+ Context + Skills + MCP + Sub-Agents + TUI
```

TinyCode is a learning project: read this repository and you can understand how a modern
coding agent (Claude Code, Codex CLI, Pi, …) actually works. Every module is small,
readable TypeScript with explicit boundaries.

```bash
npm install
npm run build
npm run dev          # full-screen terminal agent
```

Configure a provider with an environment variable (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GROQ_API_KEY`, …) or try it offline:

```bash
TINYCODE_MODEL=mock npm run dev   # scripted mock model, no network, no key
```

---

## What is a Coding Agent?

A coding agent is an LLM placed in a loop with tools:

```
User task
   ↓  prompt
Agent Runtime (Pi)  ⇄  Model (streaming LLM API)
   ↓  "call read src/x.ts"          ← the model decides which tool to use
Tool Execution (TinyCode)
   ↓  file contents as tool result
Agent Runtime  ⇄  Model              ← loop until the model stops calling tools
   ↓
Final Answer
```

The **model** reasons and decides; the **harness** (everything in `src/`) provides
tools, enforces rules, manages context, and renders the experience. Neither trusts
the other blindly:

- The model cannot touch your machine — only registered tools run.
- Tools cannot run unchecked — every call passes the permission layer.
- Nothing is unbounded — tool output is truncated and old context is compacted.

## Why Pi?

[Pi](https://github.com/earendil-works/pi) provides the hard runtime parts so TinyCode
can focus on harness logic:

| From Pi | What it does |
|---|---|
| `@earendil-works/pi-agent-core` | `Agent` class: the loop, tool-call dispatch, streaming events, abort |
| `@earendil-works/pi-ai` | Provider catalog (`builtinModels`), auth from env vars, typed streaming, schema validation |
| `@earendil-works/pi-tui` | Alt-screen terminal UI: diff rendering, editor, scroll view, overlays |

What TinyCode builds itself: tools, permissions, sessions, context policy, skills,
MCP integration, sub-agents, TUI composition, configuration, CLI. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the exact split and how each piece works.

## Feature tour

```text
$ tinycode
┌──────────────────────────────────────────────────────────┐
│ TinyCode v1.0 — a minimal Coding Agent built on Pi       │
│                                                          │
│ ❯ you                                                    │
│   why do the tests fail?                                 │
│                                                          │
│ ● bash npm test                                          │
│   ✗ exit 1 · 2.4s                                        │
│                                                          │
│ ● edit src/math.ts                                       │
│   ✓ +1 -1                                                │
│   - return a - b                                         │
│   + return a + b                                         │
│                                                          │
│ ● bash npm test                                          │
│   ✓ exit 0 · 1.9s                                        │
│                                                          │
│ Fixed: add() subtracted instead of adding. Tests pass.   │
├──────────────────────────────────────────────────────────┤
│ ◐ thinking…                                              │
│ > _                                                      │
│ ● ready · anthropic/claude-sonnet-4 tinycode · ctx ~12k  │
└──────────────────────────────────────────────────────────┘
```

- **Streaming** — model output renders token-by-token; tool calls show live status.
- **7 built-in tools** — `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, plus
  `load_skill` and sub-agent tools, all through one registry.
- **Permissions** — read-only work inside the project runs freely; writes, installs and
  dangerous shell commands trigger a dialog (*Allow once / Always allow this pattern / Deny*).
  `--permission-mode auto` approves asks automatically for CI.
- **Sessions** — JSONL persistence under `~/.tinycode/sessions`; resume with
  `tinycode --continue` or `--session <id>`, or `/resume` inside the app.
- **Context engineering** — oversized tool results are truncated head+tail with the full
  output saved as an artifact; above a token budget older turns are summarized into a
  `<conversation-summary>` message (`/compact` to force it).
- **Project memory** — `TINY.md` in the repo root is injected into the system prompt
  (`AGENTS.md`/`CLAUDE.md` are also honored).
- **Skills** — `.tinycode/skills/<name>/SKILL.md` folders with frontmatter; only names and
  descriptions enter the prompt, bodies load on demand via `load_skill`.
- **MCP** — stdio servers configured in `.tinycode/config.json` connect at startup and their
  tools merge into the same registry; `/mcp` shows status.
- **Sub-agents** — the root agent can spawn up to 3 read-only workers with independent
  contexts (`spawn_agent`/`wait_agent`/`list_agents`/`close_agent`); the status bar shows
  `SUB-AGENTS n/3 RUNNING`.
- **Slash commands** — `/help /new /clear /resume /sessions /model /skills /mcp /agents
  /compact /status /exit`.

## Non-interactive mode

```bash
tinycode -p "describe this project"
tinycode -p "fix the failing test" --permission-mode auto --model anthropic/claude-sonnet-4
```

Prints the final answer and exits — the same harness, no UI.

## Configuration

`.tinycode/config.json` (project) — all keys optional:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "permissionMode": "ask",
  "context": {
    "compactAboveTokens": 80000,
    "keepRecentMessages": 12,
    "maxToolResultChars": 30000
  },
  "mcpServers": {
    "example": { "command": "node", "args": ["server.js"] }
  }
}
```

Environment: `ANTHROPIC_API_KEY` & co. (never put keys in files), `TINYCODE_MODEL`
(`provider/model` or `mock`), `TINYCODE_PERMISSION_MODE=ask|auto`,
`TINYCODE_HOME` (redirect data dir — used by the test suite).

## Testing

```bash
npm test            # 115 tests across 11 files
npm run typecheck
npm run lint
npm run build
```

The suite runs fully offline. A scripted **mock model** drives the real agent loop:
the E2E test fixes a deliberately broken fixture project via
`bash → read → edit → bash → final` and asserts the fixture's tests pass.
An MCP integration test spawns a real stdio server from `fixtures/mock-mcp/`.

## Learn more

Read in this order:

1. [ARCHITECTURE.md](./ARCHITECTURE.md) — the map: modules, data flow, design decisions.
2. `src/agent/runtime.ts` — how the Pi `Agent` gets wired to harness policies (~100 lines).
3. `src/tools/read.ts` … — each tool is one self-contained file.
4. `tests/harness.e2e.test.ts` — the whole story in one executable scenario.

## License

MIT
