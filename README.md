<div align="center">

# TinyCode

**A minimal but complete Coding Agent Harness — the readable way to learn how coding agents actually work.**

[![CI](https://github.com/helsome/tinycode/actions/workflows/ci.yml/badge.svg)](https://github.com/helsome/tinycode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-brightgreen)](./package.json)
[![Tests](https://img.shields.io/badge/tests-115%20passing-success)](./tests)

Built on [Pi](https://github.com/earendil-works/pi) · TypeScript · ESM · ~6k lines, every one meant to be read.

</div>

---

Most coding agents are products: hundreds of thousands of lines, closed or sprawling, impossible
to hold in your head. TinyCode is the opposite — a **complete agent harness you can finish
reading in an afternoon**, with every subsystem a production agent has:

```
Model  +  Agent Loop  +  Tools  +  Permissions  +  Session
+  Context Engineering  +  Skills  +  MCP  +  Sub-Agents  +  TUI
```

It runs real tasks against real LLM providers — and because it is built on
[Pi](https://github.com/earendil-works/pi)'s runtime (`pi-agent-core`, `pi-ai`, `pi-tui`),
none of the code is scaffolding theater. The loop streams, tools execute, sessions persist.

## Demo

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

## How it compares

TinyCode does not compete with production agents on features — it competes on
**being understandable**. If you have ever wanted to know what happens between your
prompt and `rm -rf`, this table is for you.

| Project | Language | Source | Positioning | Readable as a first agent? |
|---|---|---|---|---|
| **TinyCode** | TypeScript | MIT | Complete learning harness | ✅ ~6k lines, guided tour in README + ARCHITECTURE |
| Claude Code | TypeScript* | ✗ proprietary | Production agent product | ✗ |
| OpenAI Codex CLI | Rust | OSS | Production agent CLI | ⚠️ large |
| OpenCode | TS + Go | OSS | Production agent IDE/CLI | ⚠️ multi-process |
| Gemini CLI | TypeScript | Apache-2.0 | Production agent CLI | ⚠️ large |
| Aider | Python | Apache-2.0 | AI pair programmer (git-centric) | ⚠️ different architecture |
| pi coding-agent | TypeScript | OSS | Full-featured agent + SDK on Pi | ✅ great next step after TinyCode |
| MiniCode | TypeScript | OSS | Educational mini agent | ✅ similar spirit |

<sub>* Claude Code ships minified; internals are inferred from behavior.</sub>

**What TinyCode has that most tutorials don't:** permissions with a real approval dialog,
resumable JSONL sessions, context compaction, progressive-disclosure skills, live MCP
integration, supervised read-only sub-agents — all wired to a streaming TUI, all tested
offline against a scripted model.

## Quick start

```bash
git clone https://github.com/helsome/tinycode.git
cd tinycode && npm install && npm run build
```

```bash
npm run dev                                  # full-screen terminal agent
ANTHROPIC_API_KEY=sk-… npm run dev           # e.g. Anthropic — keys come from env only
TINYCODE_MODEL=mock npm run dev              # offline: scripted mock model, zero setup
tinycode -p "describe this project"          # one-shot mode (read-only by default)
tinycode -p "refactor x" --permission-mode auto   # explicit opt-in to unattended writes
```

> **No key yet?** TinyCode still starts: it launches in MOCK mode and shows a setup panel
> with exact steps (export a key → restart). Nothing to configure upfront.

> **Non-interactive safety:** `-p` runs headless — there is no approval dialog. ASK-level
> operations are therefore **denied** unless you explicitly pass `--permission-mode auto`
> (or set `TINYCODE_PERMISSION_MODE=auto`). Read-only commands run normally.

Supported providers include Anthropic, OpenAI, Groq, DeepSeek, Mistral, OpenRouter,
Google and [more](https://github.com/earendil-works/pi) — everything Pi's catalog covers.

## Features

- **7 built-in tools** — `read` (windowed, line-numbered), `write`, `edit` (exact-match with
  diff preview), `bash` (timeout, abort, output capping), `grep`, `find`, `ls` — plus
  `load_skill` and four sub-agent tools through one registry.
- **Streaming TUI** — tokens render live; tool calls show `● bash npm test → ✓ exit 0 · 2.4s`;
  edits show `+12 -3` diffs.
- **Permissions** — reads inside the project flow freely; writes, installs and dangerous shell
  commands open an approval dialog (*Allow once / Always allow this pattern / Deny*).
  A heuristic classifier routes `npm test` vs `rm -rf` vs `curl … | sh`.
- **Sessions** — every interactive launch owns a live session (append-only JSONL under
  `~/.tinycode/sessions`). Resume with `--continue` (newest session *of the current
  directory only*), `--session <id>` or `/resume`; `/new` starts fresh at any time.
- **Context engineering** — oversized tool results truncate head+tail with full output saved
  as artifacts; past a token budget, old turns compact into a `<conversation-summary>`
  while recent messages stay verbatim.
- **Project memory** — `TINY.md` in the repo root joins the system prompt
  (`AGENTS.md`/`CLAUDE.md` honored too).
- **Skills** — `.tinycode/skills/<name>/SKILL.md`; only names/descriptions enter the prompt,
  bodies load on demand via `load_skill`.
- **MCP** — stdio servers from `.tinycode/config.json` connect at startup; their tools merge
  into the same registry. One broken server never takes the app down.
- **Sub-agents** — up to 3 read-only workers with independent contexts and aborts;
  `spawn_agent` / `wait_agent` / `list_agents` / `close_agent`.
- **Slash commands** — `/help /new /clear /resume /sessions /model /skills /mcp /agents
  /compact /status /exit`.

## Configuration

`.tinycode/config.json` (all keys optional):

```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-haiku-4.5",
  "maxOutputTokens": 16384,
  "permissionMode": "ask",
  "context": { "compactAboveTokens": 80000, "keepRecentMessages": 12 },
  "mcpServers": {
    "example": { "command": "node", "args": ["server.js"] }
  }
}
```

Environment: provider API keys, `TINYCODE_MODEL=provider/model` (or `mock`),
`TINYCODE_PERMISSION_MODE=ask|auto`, `TINYCODE_HOME` (data-dir redirect used by tests).

## Security notes

TinyCode's permission system is an **approval layer + workspace path guard, not an OS sandbox**:

- File tools enforce the project boundary with symlink-aware canonicalization (`realpath`
  both sides), so `link -> /etc/hosts` cannot be used to escape the workspace.
- Shell commands pass a risk classifier plus the same approval flow; they are not confined —
  an approved `bash` call can do anything your user can.
- Running genuinely untrusted code/tasks requires an external sandbox (container, VM).
- **API keys live in environment variables only.** `.gitignore` already excludes
  `.env*`, `*.key`, `*.pem` and `.tinycode/*.local.json`; if a secret-looking field
  appears in `.tinycode/config.json` (which is meant to be committed), startup prints
  a loud warning.

## Documentation

| Doc | Contents |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The map: modules, data flow, what comes from Pi vs TinyCode |
| `src/agent/runtime.ts` | Start here — how the Pi `Agent` gets its policies (~100 lines) |
| `tests/harness.e2e.test.ts` | The whole story as one executable scenario |

## Testing

Fully offline — no API key needed, ever:

```bash
npm test            # 115 tests: unit, integration, E2E harness, TUI, CLI smoke
npm run typecheck   # strict TypeScript
npm run lint        # eslint
npm run build       # tsc → dist/
```

The flagship test scripts a deterministic mock model that drives the **real** agent loop
through `bash → read → edit → bash → final` to fix a deliberately broken fixture project,
then asserts the fixture's tests pass and the session file is complete. An MCP integration
test spawns a genuine stdio server process. CI runs the same gates on Node 22 and 24.

## Contributing

Issues and PRs welcome. The bar for new code is the one the project already sets:
small modules, explicit boundaries, tests that run without network access.
If a feature needs more than ~300 lines to explain, it probably belongs in a layer below.

## Acknowledgements

- [Pi](https://github.com/earendil-works/pi) by Earendil — runtime foundation and the best
  reference implementation of a modern coding agent.
- [MiniCode](https://github.com/LiuMengxuan04/MiniCode) — inspiration for the
  *learn-by-building-a-harness* format.

## License

[MIT](./LICENSE)
