# TinyCode Architecture

This document explains how TinyCode works: the modules, the data flow, and — most
importantly — **which capabilities come from Pi and which TinyCode implements itself**.

```
                 TinyCode TUI  (src/tui)
                      │
                      ▼
              TinyCode Runtime  (src/agent/runtime.ts)
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
     Context      Permission     Session
   (src/context) (src/perms*)  (src/session)
        │
        ▼
   Pi Agent Core  (@earendil-works/pi-agent-core)
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
       Model               Tools
  (pi-ai + src/model)  (src/tools registry)
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
          Built-in         MCP            Sub-Agents
        (7 tools)    (src/mcp)        (src/agents)

* src/permissions
```

## 1. Agent runtime

**Pi provides:** the `Agent` class — a stateful wrapper around the low-level agent loop.
It owns the transcript (`state.messages`), executes tools, emits lifecycle events, and
supports `abort()` via `AbortController`.

**TinyCode provides:** `TinyCodeRuntime` (`src/agent/runtime.ts`, ~100 lines) which wires
the `Agent` to harness policies through four integration points:

| Hook | Policy installed |
|---|---|
| `streamFn` | `Models.streamSimple` from our model registry (auth-resolved streaming) |
| `beforeToolCall` | permission gate — can block with a reason shown to the model |
| `afterToolCall` | tool-result truncation (context hygiene) |
| `transformContext` | auto-compaction of oversized history before each request |
| `subscribe` | session persistence of every finalized message |

`bootstrap.ts` assembles all of this into a `Harness` object used by both the TUI and
the one-shot CLI mode.

## 2. Agent loop

The loop lives in Pi (`agentLoop`): stream an assistant turn → if it contains tool calls,
validate arguments against the tool's TypeBox schema → run our hooks → execute tools
(sequentially or parallel) → append results → repeat until no tool calls remain or the run
is aborted. A `length` stop reason (token cutoff) fails pending tool calls instead of
executing truncated arguments.

What TinyCode adds to the loop is policy, not control flow: nothing in TinyCode re-derives
"when to stop" or "how to parse tool calls".

## 3. Tool registry

Every tool is a Pi `AgentTool`: `{ name, description, label, parameters (TypeBox), execute }`.
`execute(toolCallId, params, signal, onUpdate)` returns `{ content, details }`:

- `content` goes back to the model (text).
- `details` is structured data for the UI (exit codes, diff stats, line counts).

`ToolRegistry` (src/tools/registry.ts) is a name→tool map. Built-ins register first;
MCP tools and sub-agent tools join the same namespace at startup, so the model sees one
uniform surface.

### The seven built-ins

| Tool | Notable behavior |
|---|---|
| `read` | numbered lines, `offset`/`limit` windows, binary detection, friendly ENOENT/EISDIR errors |
| `write` | creates parent dirs, reports `+a -d` against previous content |
| `edit` | exact-match replace; fails on 0 matches; fails on >1 match unless `replaceAll`; returns unified diff |
| `bash` | timeout + AbortSignal + SIGKILL escalation, head+tail output capture (100 KB cap) |
| `grep` | JS regex over text files, `include` glob filter, result cap, skips node_modules/.git/binary |
| `find` | glob (`**` crosses dirs), sorted relative paths |
| `ls` | type markers + sizes, dirs first |

All path-taking tools enforce the project boundary through `resolveWorkspacePath`
(src/tools/paths.ts) before any I/O: the lexical path is resolved, then **canonicalized with
`fs.realpathSync` on both sides** (existing target — or nearest existing ancestor for new
files — versus canonical project root). Symlink escapes (`link -> /etc/hosts`, writing through
a symlinked directory, broken symlinks) are rejected with a model-friendly
`Path resolves outside project directory: …` error while ordinary relative paths keep working.

## 4. Tool execution flow

```
model emits toolCall(id, name, args)
  → schema validation (pi-ai validateToolArguments)
  → Agent.beforeToolCall → PermissionManager.check(name, args)
        allow → continue
        ask   → remembered pattern? mode=auto? → allow
                else prompt callback (TUI dialog / headless deny)
        deny  → blocked; error toolResult explains why
  → tool.execute(...)          [abortable]
  → Agent.afterToolCall → ContextManager truncates oversized content,
        full output saved as artifact file
  → ToolResultMessage appended to transcript (+ session file, + UI event)
```

Errors thrown inside `execute` become `isError` tool results — the model sees a readable
sentence ("oldText not found … copy exactly"), never a stack trace. Non-zero bash exit codes
are *not* errors by design: stdout/stderr carry the payload the model needs.

## 5. Permission system

Three layers (src/permissions):

1. **classifier.ts** — shell commands are split on `&&`/`;`/`|` and classified per segment:
   `safe` (git status, npm test, cat…), `write` (npm install, mkdir, redirections…),
   `destructive` (rm -r/-f, git reset --hard, git clean, sudo, pipe-into-shell…).
   Unknown verbs are treated as `write`.
2. **rules.ts** — per-tool defaults: reads inside the project → ALLOW; writes anywhere and
   reads outside → ASK; bash routes through the classifier; unknown tools → ASK.
3. **manager.ts** — the runtime gate. Order of evaluation:

```
hard DENY rule (catastrophic shell: rm -rf /, mkfs, raw disk write, …)
  → refused unconditionally; auto mode and dialogs can never override it
ALLOW verdict → run
ASK verdict   → remembered "always allow" pattern?
                → mode === "auto"?            approved
                → prompt callback available?  dialog decides
                → otherwise                   safe DENY
```

Semantics differ by surface: the TUI shows the dialog (*Allow once / Always allow this
pattern / Deny*); headless `-p` has no dialog, so its default is deny-on-ASK and automation
requires the explicit `--permission-mode auto` opt-in. SIGINT and the Ctrl+C binding share
the same interrupt logic so ISIG terminals behave identically.

## 6. Context engineering

`ContextManager` (src/context) owns two policies:

- **Per-result truncation** (`afterToolCall`): text over `maxToolResultChars` keeps head+tail
  with an explicit `[… N characters truncated …]` marker; the full output is saved under
  `<dataHome>/sessions/artifacts/`.
- **Budget & compaction**: token estimate ≈ chars/4 (deterministic, offline). When the
  transcript exceeds `compactAboveTokens`, `transformContext` replaces older turns with one
  LLM-generated summary wrapped in `<conversation-summary>` tags. Cut points sit on user-message
  boundaries so assistant turns never lose their tool results; the newest `keepRecentMessages`
  are always verbatim. `/compact` runs the same routine on demand.
  Compaction protects: recent user tasks, recent tool calls/results/errors, recent edits —
  because those are exactly the last messages kept.

## 7. Session

Every interactive launch owns a session from message one: plain `tinycode` maps to
`{mode:"new"}`, `--continue` attaches the newest session whose stored cwd matches (never
another project's; falls back to a new session with a note when none matches), `--session <id>`
attaches exactly that id. `/new` rotates the id and clears the live transcript — Pi's
`Agent.reset()` preserves systemPrompt/model/tools/hooks, so tool calling continues seamlessly.

One JSONL file per session in `<dataHome>/sessions/<id>.jsonl` (id = UUIDv7):

```jsonl
{"type":"session","id":"…","cwd":"…","createdAt":"…","model":"anthropic/claude-sonnet-4","title":"fix tests"}
{"type":"message","message":{ …user… }}
{"type":"message","message":{ …assistant… }}
{"type":"message","message":{ …toolResult… }}
```

Writes are synchronous appends — files are never truncated after creation (the first real
prompt adds the title by rewriting the not-yet-valuable header line only). `attach()` is
strictly read-only: it restores the transcript into the live `Agent` and keeps appending to
the same file, so a crash during resume cannot destroy history. A torn final line (crash
mid-append) is skipped on load. Tests redirect storage via `TINYCODE_HOME`.

## 8. Skills

A skill is `.tinycode/skills/<name>/SKILL.md` (plus a user-level mirror in `~/.tinycode/skills`):

```markdown
---
name: code-review
description: Review code changes for correctness and maintainability.
---
# instructions…
```

Progressive disclosure: the system prompt receives only `name: description` lines. When a
skill matches the task, the model calls `load_skill(name)` and the full body arrives as a
normal tool result — costing context tokens only when used.

## 9. MCP

`mcpServers` entries spawn stdio servers via `@modelcontextprotocol/sdk`
(`StdioClientTransport`). Startup connects all servers in parallel with an initialize
timeout; a failing server records its status instead of crashing the app. Each server's
tools are adapted into regular `AgentTool`s (`callTool` under the hood, JSON-Schema passed
through — pi-ai validates plain JSON Schemas too). Name collisions resolve to `<server>_<tool>`.
`/mcp` lists status, tool counts and errors; shutdown closes transports cleanly (no child leaks).

## 10. Multi-agent

`SubAgentManager` spawns **read-only workers**: independent Pi `Agent` instances with their
own transcripts, AbortControllers, a read-only tool subset (read/grep/find/ls, optionally
safe MCP tools) and a fixed worker system prompt. Hard rules prevent swarms: max 3 concurrent,
workers never receive sub-agent tools. The root coordinates via
`spawn_agent` / `list_agents` / `wait_agent` (collects the final assistant message as a
structured report) / `close_agent` (abort). The status bar surfaces `SUB-AGENTS n/3 RUNNING`.

## 11. TUI

Built from pi-tui components — no hand-rolled ANSI screens:

```
TuiAltScreen (alt buffer, differential rendering)
└── VStack layout root
    ├── ScrollView(transcriptContainer)   follow:"end", primary
    └── VStack
        ├── LoaderHost        "◐ thinking…" / running-tool count
        ├── Editor            multi-line input, history, slash autocomplete
        └── StatusBar         ● ready · model cwd · ctx ~Nk · SUB-AGENTS · session
```

The app subscribes to `AgentEvent`s and maps them onto components:
`message_update` → live streaming text (finalized into Markdown at `message_end`),
`tool_execution_start/end` → `● bash npm test` + `✓ exit 0 · 2.4s` lines with diff previews,
errors → red info lines. Permission asks open a centered overlay dialog (SelectList).

Keybindings: `Enter` submit · `Ctrl+C` abort generation, twice-to-exit when idle ·
`Esc` abort · `Ctrl+D` quit · arrows scroll/history. One rule learned the hard way:
**component mutations need explicit `tui.requestRender()`** — input-driven repaints alone
leave timer-driven updates invisible.

## 12. Model configuration

`ModelRegistry` wraps pi-ai's `builtinModels()` (every supported provider, auth resolved
from environment variables). Selection order: CLI `--model provider/id` > `TINYCODE_MODEL` >
`.tinycode/config.json` > first auth-configured provider. `TINYCODE_MODEL=mock` registers
pi's scripted `fauxProvider` so the entire loop — including tests and `-p` smoke runs —
works with zero network. Missing credentials produce actionable guidance, not crashes.

---

## What comes from where (summary)

| Capability | Source |
|---|---|
| Agent loop, tool dispatch, streaming events, abort | Pi agent-core |
| Provider catalog, env-var auth, request streaming, schema validation | Pi ai |
| Terminal renderer, editor, scroll view, overlays, select lists | Pi tui |
| All 7 coding tools, registry | TinyCode |
| Permission classifier/rules/gate/dialog | TinyCode |
| JSONL sessions, resume, titles | TinyCode |
| Truncation, budgeting, compaction | TinyCode |
| System prompt, TINY.md memory | TinyCode |
| Skill discovery/loading, progressive disclosure | TinyCode |
| MCP client lifecycle + adapter | TinyCode (on official MCP SDK) |
| Sub-agent supervision | TinyCode |
| TUI composition, slash commands, CLI, config | TinyCode |
