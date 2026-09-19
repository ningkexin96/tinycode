<div align="center">

# TinyCode · 客服工单分流智能体

**一个基于 Agent Loop 的对话式业务智能助手框架 —— 已适配客服工单分流场景。**

[![CI](https://github.com/ningkexin96/tinycode/actions/workflows/ci.yml/badge.svg)](https://github.com/ningkexin96/tinycode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-brightgreen)](./package.json)

基于 [Pi](https://github.com/earendil-works/pi) 运行时构建 · TypeScript · ESM · Function-Calling · ToolRegistry · Agent-Loop · Diff 变更校验 · Skill 插件体系

</div>

---

## 项目简介

TinyCode 把「客服工单分流」抽象成一个可运行的业务智能体：读单 → 查知识库 → 判定分类/优先级/意图 →
分流到队列 →（必要时）升级。它不是一个玩具 Demo，而是围绕四类真实工程问题设计的框架：

| 工程问题 | 对应设计 |
|---|---|
| 工单长会话无状态、上下文丢失 | **Agent Loop 多轮执行闭环** `runAgentTurn`，判定结果落盘 + 会话持久化 |
| 工具接入侵入调度核心 | **ToolDefinition + ToolRegistry**，新增工具只注册元数据，不改 Agent 主循环 |
| AI 擅自篡改知识库 | **写入前审查 + Diff 变更校验**，知识库修改强制人工审批 |
| 全量业务规则撑爆上下文 | **Skills 渐进式加载**，摘要预发现 + 按需加载完整 SOP |

## 演示

```text
$ tinycode
┌────────────────────────────────────────────────────────────┐
│ TinyCode v1.0 — 客服工单分流业务智能体（基于 Pi）           │
│                                                            │
│ ❯ 客服                                                     │
│   T-1001 帮我判定并分流                                     │
│                                                            │
│ ● list_tickets                                             │
│   ✓ 3 条工单                                               │
│ ● get_ticket T-1001                                        │
│   ✓ T-1001                                                 │
│ ● search_knowledge 退款 时效                                │
│   ✓ 1 篇知识                                               │
│ ● read_article refund-policy                               │
│   ✓ 退款政策                                               │
│ ● classify_ticket T-1001 退款 P1                           │
│   ✓ 退款 · P1 → triaged                                    │
│ ● route_ticket T-1001 → 售后组                              │
│   ✓ → 售后组 · routed                                      │
│                                                            │
│ T-1001 已判定为「退款 / P1」，分流到售后组，依据 refund-policy。 │
├────────────────────────────────────────────────────────────┤
│ ◐ 思考中…                                                  │
│ > _                                                        │
│ ● 就绪 · anthropic/claude-sonnet-4 tinycode · ctx ~12k     │
└────────────────────────────────────────────────────────────┘
```

## 快速开始

```bash
git clone https://github.com/ningkexin96/tinycode.git
cd tinycode && npm install && npm run build
```

```bash
npm run dev                                    # 全屏终端智能体
ANTHROPIC_API_KEY=sk-… npm run dev             # 例如 Anthropic —— 密钥只从环境变量读取
TINYCODE_MODEL=mock npm run dev                # 离线：脚本化 mock 模型，零配置
tinycode -p "把 T-1001 判定并分流"               # 一次性模式（只读工具默认放行）
tinycode -p "修一下知识库" --permission-mode auto     # 显式选择无人值守写入
```

> **还没有密钥？** TinyCode 依然能启动：它进入 MOCK 模式并展示设置面板（导出密钥 → 重启）。

> **非交互安全：** `-p` 无审批弹窗，因此 ASK 级操作默认**拒绝**，除非显式传入
> `--permission-mode auto`（或 `TINYCODE_PERMISSION_MODE=auto`）。

## 工作区结构

一个「客服工作区」就是 Agent 的工作目录：

```
workspace/
├─ tickets/                 # 工单（每条一个 JSON）
│  └─ T-1001.json
├─ knowledge/               # 知识库（每篇 SOP / 政策一个 Markdown）
│  ├─ refund-policy.md
│  └─ logistics-sla.md
├─ TINY.md                  # 业务规则（注入系统提示）
└─ .tinycode/
   ├─ config.json           # 模型 / 权限 / 队列 / 目录 / MCP
   └─ skills/               # 技能（渐进式加载）
      ├─ triage-sop/SKILL.md
      └─ escalation-rules/SKILL.md
```

仓库自带一个可直接试跑的示例工作区：[`fixtures/support-desk`](./fixtures/support-desk)。

## 工具清单

所有业务工具都通过 **ToolRegistry** 注册，模型看到的是统一的一层工具面。
新增工具只需实现 `ToolDefinition` 并注册，**无需改动 Agent 调度循环**。

| 工具 | 作用 | 权限 |
|---|---|---|
| `list_tickets` | 按状态/队列/优先级/分类盘点工单 | 放行 |
| `get_ticket` | 读取工单全文（会话 + 备注） | 放行 |
| `search_tickets` | 工单全文检索 | 放行 |
| `search_knowledge` | 知识库检索（返回文章 id / 标题 / 片断） | 放行 |
| `read_article` | 读取知识库文章正文 | 放行 |
| `classify_ticket` | 落盘分类 / 优先级 / 意图（status→triaged） | 放行 |
| `route_ticket` | 分流到队列（status→routed） | 放行 |
| `escalate_ticket` | 升级到 L1 / L2（status→escalated） | L2 需审批 |
| `reply_customer` | 写入对客回复（对外动作） | 需审批 |
| `propose_knowledge_edit` | 知识库写入（生成 Diff，人工审批） | 需审批 |
| `load_skill` | 按需加载技能正文 | 放行 |
| `spawn_agent` / `list_agents` / `wait_agent` / `close_agent` | 只读调研子智能体 | 需审批 |

## 知识库写入审查 + Diff 流程

`propose_knowledge_edit` 覆盖了「AI 擅自篡改知识库」这条风险：

```
模型提出 article_id / old_text / new_text / rationale
  → 权限门判定：
       old_text === new_text  → 短路跳过（不触发审批，不落盘）
       其余                    → ASK（人工审批）
  → 人工审批弹窗展示「理由 + 替换前后文本」
       允许 → 生成统一 Diff 并落盘，Diff 回传给模型核对
       拒绝 / 无审批通道（无头模式）→ 阻塞，文件不变
```

关键点：**知识库写入不会被「总是允许」记忆**，每次改动都必须重新过一遍人工，
从机制上保证知识数据安全。

## Skills 渐进式加载

技能放在 `.tinycode/skills/<name>/SKILL.md`（frontmatter 带 `name` / `description`）。

- 系统提示里**只注入 `name: description` 摘要**；
- 当技能与当前工单相关时，模型调用 `load_skill` 按需拉取完整 SOP 正文；
- 与工单无关的业务规则**不会被加载**，从而缓解输入 Token 膨胀与上下文溢出。

示例技能：`triage-sop`（分流标准流程）、`escalation-rules`（升级判断规则）。

## 配置

`.tinycode/config.json`（所有键均可选）：

```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-haiku-4.5",
  "permissionMode": "ask",
  "knowledgeDir": "knowledge",
  "ticketsDir": "tickets",
  "queues": ["售后组", "物流组", "技术支持"],
  "maxStepsPerTurn": 12,
  "context": { "compactAboveTokens": 80000, "keepRecentMessages": 12 },
  "mcpServers": {
    "example": { "command": "node", "args": ["server.js"] }
  }
}
```

环境变量：提供商 API 密钥、`TINYCODE_MODEL=provider/model`（或 `mock`）、
`TINYCODE_PERMISSION_MODE=ask|auto`、`TINYCODE_HOME`（数据目录重定向，测试会用到）。

## 稳定性兜底

`runAgentTurn` 是 TUI 与无头模式共用的多轮执行闭环，对长工单会话的三类异常给出兜底：

- **最大步数保护**：单轮工具调用超过 `maxStepsPerTurn` 时中止本轮，避免失控循环；
- **空响应兜底**：模型本轮未返回任何正文（含只输出思考的情况）时返回结构化结果而非挂起；
- **上下文压缩**：超出 token 预算后，较早轮次压缩为 `<conversation-summary>`，近期消息保持原文。

## 测试

完全离线 —— 永远不需要 API 密钥：

```bash
npm test            # 单元 / 集成 / E2E / TUI / CLI 冒烟
npm run typecheck   # 严格 TypeScript
npm run lint        # eslint
npm run build       # tsc → dist/
```

旗舰 E2E 测试用脚本化的 mock 模型驱动**真实的** Agent 循环，对一个客服工作区 fixture
走完 `list_tickets → get_ticket → search_knowledge → classify_ticket → propose_knowledge_edit → route_ticket`，
然后断言工单状态与知识库改动均正确落盘。

## 文档

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构地图：模块、数据流、会话/权限/上下文策略 |
| `src/agent/runtime.ts` | 多轮执行闭环 `runAgentTurn` 与兜底策略 |
| `src/tools/knowledge.ts` | 知识库写入审查 + Diff 流程 |

## 安全说明

- TinyCode 的权限系统是**审批层，不是操作系统沙箱**；工具作用域限制在工作区内。
- **API 密钥只存在于环境变量中**；`.gitignore` 已排除 `.env*` / `*.key` / `*.pem`。
- 知识库写入与对客回复都需要人工审批；无审批通道时（无头模式）默认阻塞。

## 致谢

- [Pi](https://github.com/earendil-works/pi)（Earendil）—— 运行时基础与参考实现。

## 许可证

[MIT](./LICENSE)
