# TinyCode 架构（客服工单分流）

本文说明 TinyCode 如何把「客服工单分流」实现成一个可运行的业务智能体：
模块划分、数据流，以及**哪些能力来自 Pi、哪些由 TinyCode 自己实现**。

```
                     TinyCode TUI  (src/tui)
                          │
                          ▼
              TinyCode Runtime  (src/agent/runtime.ts)
              ── runAgentTurn：多轮执行闭环 + 兜底策略 ──
        ┌─────────────┼──────────────┬──────────────┐
        ▼             ▼              ▼              ▼
     ToolRegistry  Permission     Context        Session
     (src/tools)   (src/perm*)   (src/context)  (src/session)
        │             │
        ▼             ▼
   业务工具 (10)   Diff 审查 + 审批门
        │
        ▼
   Pi Agent Core  (@earendil-works/pi-agent-core)  ← Agent Loop / 流式 / 工具分发
        │
   ┌────┴─────┬───────────┬──────────┐
   ▼          ▼           ▼          ▼
 模型        领域层       技能        子智能体 / MCP
(pi-ai)  (src/domain)  (src/skills)  (src/agents, src/mcp)
```

## 1. 领域层（src/domain）

客服工作区的两类数据：

| 数据 | 存储 | 读/写 API |
|---|---|---|
| 工单 | `tickets/<id>.json` | `listTickets` / `readTicket` / `writeTicket` / `searchTickets` |
| 知识库 | `knowledge/<id>.md`（frontmatter + Markdown） | `listArticles` / `readArticle` / `searchArticles` |

- `src/domain/types.ts` —— `Ticket` / `TicketMessage` / `TicketNote` / `KnowledgeArticle` 类型。
- `src/domain/tickets.ts` / `knowledge.ts` —— 文件读写 + 过滤 + 全文检索（`search.ts` 提供分词/打分/片断）。
- 目录名可通过 `.tinycode/config.json` 的 `knowledgeDir` / `ticketsDir` 覆盖；
  id 统一经 `sanitizeId` 归一化，模型无法用 id 逃逸出目录。

## 2. Agent 运行时与多轮执行闭环（src/agent/runtime.ts）

**Pi 提供：** `Agent` —— 有状态的低层 Agent Loop 包装（拥有 transcript、执行工具、发出生命周期事件、支持 `abort()`）。

**TinyCode 提供：** `TinyCodeRuntime`，把 `Agent` 接到 harness 策略上，并在其之上实现
`runAgentTurn` —— TUI 与无头模式共用的**多轮执行闭环**：

| 钩子 / 方法 | 策略 |
|---|---|
| `streamFn` | 模型注册表的 `Models.streamSimple`（含鉴权的流式请求） |
| `beforeToolCall` | 权限门 —— 可 `block` 并把原因回传给模型 |
| `afterToolCall` | 工具结果截断（上下文卫生） |
| `transformContext` | 每次请求前的自动压缩 |
| `shouldStopAfterTurn` | **最大步数保护**（仅在 `runAgentTurn` 期间生效） |
| `subscribe` | 会话持久化 + 工具调用计数 |
| `runAgentTurn(text)` | 返回结构化结果：`completed` / `empty-response` / `max-steps` |

三层兜底解决「长工单会话无状态、上下文丢失」：

1. **最大步数保护** —— 单轮步数超过 `maxStepsPerTurn` 时中止本轮，避免工具调用失控；
2. **空响应兜底** —— 本轮没有正文（含只输出思考）时返回结构化结果而非挂起；
3. **判定落盘 + 会话持久化** —— 分类/分流结果写入工单 JSON，消息写入 JSONL 会话，
   即使长会话被压缩，判定结论也不会丢。

`bootstrap.ts` 把以上组装成 `Harness`，TUI 与一次性 CLI 共用。

## 3. 工具注册中心（ToolDefinition + ToolRegistry）

每个工具是一个 Pi `AgentTool`：`{ name, description, label, parameters (TypeBox), execute }`。

- `execute(toolCallId, params, signal, onUpdate)` 返回 `{ content, details }`：
  `content` 回给模型（文本），`details` 给 UI（计数、diff、状态…）。
- `ToolRegistry`（`src/tools/registry.ts`）是 name→tool 映射：内置业务工具先注册，
  MCP 工具与子智能体工具在启动时并入**同一个命名空间**，模型只看到一层统一工具面。
- **插件式接入**：新增一个工单业务工具 = 写一个工厂函数 + 在 `bootstrap.ts` 注册一行，
  **无需改动 Agent 主调度循环**。入参 Schema 校验、失败回传纠错都由 Pi 的
  `validateToolArguments` 与「抛错即 isError 工具结果」机制统一处理。

### 业务工具清单

| 分类 | 工具 |
|---|---|
| 查询（放行） | `list_tickets` / `get_ticket` / `search_tickets` / `search_knowledge` / `read_article` |
| 处理（放行） | `classify_ticket` / `route_ticket` |
| 需审批 | `escalate_ticket`(L2) / `reply_customer` / `propose_knowledge_edit` |
| 技能 | `load_skill` |
| 子智能体 | `spawn_agent` / `list_agents` / `wait_agent` / `close_agent` |

## 4. 工具执行流程

```
模型发出 toolCall(id, name, args)
  → Schema 校验（pi-ai validateToolArguments）
  → Agent.beforeToolCall → PermissionManager.check(name, args)
        allow → 继续
        ask   → 命中记忆模式？ mode=auto？ → 放行
                否则弹审批回调（TUI 对话框 / 无头模式默认拒绝）
        deny  → 阻塞；错误工具结果说明原因
  → tool.execute(...)          [可中止]
  → Agent.afterToolCall → ContextManager 截断超长内容，整段另存 artifact
  → ToolResultMessage 追加进 transcript（+ 会话文件 + UI 事件）
```

`execute` 内抛出的错误会变成 `isError` 工具结果 —— 模型看到的是一句可操作的话
（如「工单不存在: T-9999（先用 list_tickets 确认工单号）」），而不是堆栈。

## 5. 权限策略（src/permissions）

`rules.ts` 是一张「工具 → 判定」规则表，在执行前静态求值：

| 工具 | 判定 | 理由 |
|---|---|---|
| 查询类 + `load_skill` | ALLOW | 只读查询，长会话可自由取证 |
| `classify_ticket` / `route_ticket` | ALLOW | 常规分流记账，Agent 本职 |
| `escalate_ticket` level≥2 | ASK | 升级到主管需人工确认 |
| `escalate_ticket` level=1 | ALLOW | 升级到组长 |
| `reply_customer` | ASK | 对外动作 |
| `propose_knowledge_edit`（有改动） | ASK | 知识库写入需人工审批 |
| `propose_knowledge_edit`（无改动） | ALLOW | **短路跳过**，不占用审批 |
| 未分类工具（MCP / 子智能体 / 技能） | ASK | 默认求审批 |

`manager.ts` 是运行时闸门：`deny` 直接短路 → `allow` 直接短路 → 记忆的「总是允许」模式
→ `mode=auto` 自动放行 → 宿主 `prompt` 回调。无回调时安全拒绝。

**强审查**：`propose_knowledge_edit` 被列入 `REVIEW_REQUIRED_TOOLS`，
即使用户选了「总是允许」也不会被记忆 —— **每次知识库改动都必须重新过一遍人工**。

## 6. 知识库写入审查 + Diff（src/tools/knowledge.ts）

```
propose_knowledge_edit(article_id, old_text, new_text, rationale)
  权限门（见上）：无改动 → 短路跳过；有改动 → ASK
  审批通过后执行：
    读原文 → 校验 old_text 唯一命中 → 替换 → lineDiff → renderDiff → 落盘
    返回统一 Diff（+a -d）与理由给模型核对
```

Diff 由 `src/tools/diff.ts`（LCS 行级 diff + hunk 归并）生成，与 TUI 预览共用。
审批弹窗会展示「修改理由 + 替换前后文本」，让审批人对着 Diff 决策。

## 7. Skills 渐进式加载（src/skills）

技能 = `.tinycode/skills/<name>/SKILL.md`（frontmatter 带 `name` / `description`）。

- `SkillRegistry.summary()` 只把 `name: description` 注入系统提示；
- 模型判断技能相关时调用 `load_skill(name)`，完整 SOP 正文作为普通工具结果返回；
- 于是**只有被用到的业务规则才消耗上下文 token**，从机制上缓解「全量规则撑爆上下文」。

示例技能：`triage-sop`、`escalation-rules`。

## 8. 上下文工程（src/context）

`ContextManager` 拥有两条策略：

- **单条结果截断**（`afterToolCall`）：超过 `maxToolResultChars` 的文本保留头尾并插入
  `[… N characters truncated …]`，完整输出存到 `<dataHome>/sessions/artifacts/`。
- **预算与压缩**：token 估算 ≈ 字符数/4（确定性、离线）。超过 `compactAboveTokens` 时，
  `transformContext` 用一段 LLM 摘要替换较早轮次并包在 `<conversation-summary>` 标签里；
  切割点落在用户消息边界，最新的 `keepRecentMessages` 条始终原样保留。`/compact` 手动触发同一流程。

## 9. 会话（src/session）

每次交互启动都拥有一个会话：`tinycode` → `{mode:"new"}`，`--continue` 附加**当前目录**
最近的会话，`--session <id>` 精确附加。`/new` 轮换 id 并清空实时 transcript
（Pi 的 `Agent.reset()` 保留 systemPrompt/model/tools/hooks）。

每个会话一个 JSONL 文件（`<dataHome>/sessions/<id>.jsonl`），同步追加、只增不改。
测试通过 `TINYCODE_HOME` 重定向存储。

## 10. 子智能体与 MCP

- **子智能体**（`src/agents`）：最多 3 个**只读** worker，独立 transcript 与 AbortController，
  只读工具子集（查询类工单/知识工具）。根智能体通过 `spawn_agent` / `wait_agent` /
  `list_agents` / `close_agent` 协调，用子上下文核查「某政策原文到底怎么说」而不污染主上下文。
- **MCP**（`src/mcp`）：`mcpServers` 声明的 stdio 服务器在启动时并行连接，其工具适配为普通
  `AgentTool` 并入同一注册表；单个服务器故障只记录状态，不会拖垮应用。

## 11. TUI 与 CLI（src/tui, src/cli）

TUI 由 pi-tui 组件拼装：`ScrollView(transcript)` + `LoaderHost` + `Editor` + `StatusBar`，
权限审批是居中覆盖对话框。工具调用行由 `tool-view.ts` 渲染
（如 `● classify_ticket T-1001` → `✓ 退款 · P1 → triaged`；知识库写入展示 `+a -d` 与 diff 预览）。

斜杠命令：`/help /new /clear /resume /sessions /model /skills /mcp /agents /compact /status /exit`。

## 12. What comes from where

| 能力 | 来源 |
|---|---|
| Agent Loop、工具分发、流式事件、abort | Pi agent-core |
| 提供商目录、环境变量鉴权、流式请求、Schema 校验 | Pi ai |
| 终端渲染、编辑器、滚动视图、覆盖层 | Pi tui |
| 工单/知识库领域模型与读写 | TinyCode |
| 10 个业务工具 + 注册中心 | TinyCode |
| runAgentTurn 多轮闭环 + 兜底策略 | TinyCode |
| 权限规则/审批门 + 知识库写入审查 | TinyCode |
| JSONL 会话、恢复、标题 | TinyCode |
| 截断、预算、压缩 | TinyCode |
| 系统提示、TINY.md 业务规则 | TinyCode |
| 技能发现/加载、渐进式披露 | TinyCode |
| MCP 生命周期 + 适配 | TinyCode（基于官方 MCP SDK） |
| 子智能体调度 | TinyCode |
| TUI 组装、斜杠命令、CLI、配置 | TinyCode |
