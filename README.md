<div align="center">

# TinyCode

**一个最小但完整的编码智能体（Coding Agent）脚手架 —— 用可读的方式，真正搞懂编码智能体到底是怎么工作的。**

[![CI](https://github.com/ningkexin96/tinycode/actions/workflows/ci.yml/badge.svg)](https://github.com/ningkexin96/tinycode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-brightgreen)](./package.json)
[![Tests](https://img.shields.io/badge/tests-115%20passing-success)](./tests)

基于 [Pi](https://github.com/earendil-works/pi) 构建 · TypeScript · ESM · 约 6k 行代码，每一行都值得阅读。

</div>

---

大多数编码智能体都是“产品”：动辄数十万行代码，要么闭源、要么结构庞杂，让人很难在脑子里装下全貌。
TinyCode 恰恰相反 —— 它是一个**完整到你能在一个下午读完的 agent 脚手架**，却具备生产级智能体拥有的每一个子系统：

```
模型  +  Agent 循环  +  工具  +  权限  +  会话
+  上下文工程  +  技能  +  MCP  +  子智能体  +  TUI
```

它面向真实的 LLM 提供商运行真实任务 —— 因为它构建在
[Pi](https://github.com/earendil-works/pi) 的运行时（`pi-agent-core`、`pi-ai`、`pi-tui`）之上，
没有任何一行代码是“摆样子的脚手架”。循环会流式输出，工具会真正执行，会话会持久化保存。

## 演示

```text
$ tinycode
┌──────────────────────────────────────────────────────────┐
│ TinyCode v1.0 — 一个基于 Pi 的最小编码智能体              │
│                                                          │
│ ❯ 你                                                     │
│   为什么测试失败了？                                      │
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
│ 已修复：add() 之前做的是减法而不是加法，测试现已通过。    │
├──────────────────────────────────────────────────────────┤
│ ◐ 思考中…                                                │
│ > _                                                      │
│ ● 就绪 · anthropic/claude-sonnet-4 tinycode · ctx ~12k   │
└──────────────────────────────────────────────────────────┘
```

## 与其他项目的对比

TinyCode 并不在“功能多少”上和生产级智能体竞争 —— 它竞争的是**可理解性**。
如果你曾经好奇“从输入一句提示到执行 `rm -rf` 之间到底发生了什么”，这张表就是为你准备的。

| 项目 | 语言 | 源码 | 定位 | 适合作为第一个智能体阅读？ |
|---|---|---|---|---|
| **TinyCode** | TypeScript | MIT | 完整的学习脚手架 | ✅ 约 6k 行，README + ARCHITECTURE 全程导览 |
| Claude Code | TypeScript* | ✗ 闭源 | 生产级 agent 产品 | ✗ |
| OpenAI Codex CLI | Rust | 开源 | 生产级 agent CLI | ⚠️ 体量较大 |
| OpenCode | TS + Go | 开源 | 生产级 agent IDE/CLI | ⚠️ 多进程 |
| Gemini CLI | TypeScript | Apache-2.0 | 生产级 agent CLI | ⚠️ 体量较大 |
| Aider | Python | Apache-2.0 | AI 结对编程（以 git 为中心） | ⚠️ 架构不同 |
| pi coding-agent | TypeScript | 开源 | Pi 上功能完整的 agent + SDK | ✅ 学完 TinyCode 后的绝佳下一步 |
| MiniCode | TypeScript | 开源 | 教育向迷你 agent | ✅ 同源理念 |

<sub>* Claude Code 发布的是压缩混淆后的代码，其内部行为是从外部表现推断出来的。</sub>

**TinyCode 拥有大多数教程没有的东西：** 带真实审批弹窗的权限系统、
可恢复的 JSONL 会话、上下文压缩、渐进式披露的技能、实时的 MCP 集成、
受监督的只读子智能体 —— 全部接入一个流式 TUI，并且都能在离线状态下
对着脚本化的模型完成测试。

## 快速开始

```bash
git clone https://github.com/ningkexin96/tinycode.git
cd tinycode && npm install && npm run build
```

```bash
npm run dev                                  # 全屏终端智能体
ANTHROPIC_API_KEY=sk-… npm run dev           # 例如 Anthropic —— 密钥只从环境变量读取
TINYCODE_MODEL=mock npm run dev              # 离线：脚本化 mock 模型，零配置
tinycode -p "描述一下这个项目"                 # 一次性模式（默认只读）
tinycode -p "refactor x" --permission-mode auto   # 显式选择无人值守写入
```

> **还没有密钥？** TinyCode 依然能启动：它会进入 MOCK 模式，并展示一个带有
> 精确步骤的设置面板（导出密钥 → 重启），无需任何前置配置。

> **非交互安全：** `-p` 以无头方式运行 —— 此时不存在审批弹窗，因此 ASK 级别的
> 操作默认会被**拒绝**，除非你显式传入 `--permission-mode auto`
> （或设置 `TINYCODE_PERMISSION_MODE=auto`）。只读命令可以正常执行。

支持的提供商包括 Anthropic、OpenAI、Groq、DeepSeek、Mistral、OpenRouter、
Google 以及[更多](https://github.com/earendil-works/pi) —— 凡是 Pi 的目录所覆盖的都可以用。

## 特性

- **7 个内置工具** —— `read`（带窗口与行号）、`write`、`edit`（精确匹配 + diff 预览）、
  `bash`（超时、中止、输出截断）、`grep`、`find`、`ls` —— 再加上 `load_skill`
  与四个子智能体工具，统一挂载在同一个注册表下。
- **流式 TUI** —— token 实时渲染；工具调用显示为 `● bash npm test → ✓ exit 0 · 2.4s`；
  编辑显示 `+12 -3` 的 diff。
- **权限系统** —— 项目内的读取自由放行；写入、安装以及危险的 shell 命令会弹出审批对话框
  （*允许一次 / 始终允许该模式 / 拒绝*）。启发式分类器会区分 `npm test`、`rm -rf` 与 `curl … | sh`。
- **会话** —— 每次交互启动都拥有一个独立会话（位于 `~/.tinycode/sessions` 下的只追加 JSONL）。
  通过 `--continue`（仅限**当前目录**的最近会话）、`--session <id>` 或 `/resume` 恢复；
  `/new` 随时开启全新会话。
- **上下文工程** —— 超长的工具结果会截取头尾、完整输出另存为 artifact；超过 token 预算后，
  较早的轮次会被压缩成 `<conversation-summary>`，而近期消息保持原文。
- **项目记忆** —— 仓库根目录的 `TINY.md` 会注入系统提示（同样支持 `AGENTS.md` / `CLAUDE.md`）。
- **技能** —— `.tinycode/skills/<name>/SKILL.md`；只有名称与描述进入提示，
  正文通过 `load_skill` 按需加载。
- **MCP** —— 启动时连接来自 `.tinycode/config.json` 的 stdio 服务器，其工具并入同一注册表；
  单个服务器故障不会拖垮整个应用。
- **子智能体** —— 最多 3 个具备独立上下文与中止能力的只读 worker；
  `spawn_agent` / `wait_agent` / `list_agents` / `close_agent`。
- **斜杠命令** —— `/help /new /clear /resume /sessions /model /skills /mcp /agents
  /compact /status /exit`。

## 配置

`.tinycode/config.json`（所有键均可选）：

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

环境变量：各提供商的 API 密钥、`TINYCODE_MODEL=provider/model`（或 `mock`）、
`TINYCODE_PERMISSION_MODE=ask|auto`、`TINYCODE_HOME`（数据目录重定向，测试会用到）。

## 安全说明

TinyCode 的权限系统是一个**审批层 + 工作区路径防护，而不是操作系统沙箱**：

- 文件工具通过带符号链接感知的规范化（两侧都做 `realpath`）来强制项目边界，
  因此 `link -> /etc/hosts` 这样的链接无法逃逸出工作区。
- Shell 命令经过风险分类器并走同一审批流程；它们并不受限 ——
  一旦获批，一次 `bash` 调用可以做你的用户能做的一切。
- 运行真正不可信的代码/任务需要外部沙箱（容器、虚拟机）。
- **API 密钥只存在于环境变量中。** `.gitignore` 已经排除了 `.env*`、`*.key`、`*.pem`
  以及 `.tinycode/*.local.json`；如果 `.tinycode/config.json`（这是设计上要提交的文件）
  里出现了疑似密钥的字段，启动时会打印醒目的警告。

## 文档

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 地图：模块、数据流、哪些来自 Pi、哪些属于 TinyCode |
| `src/agent/runtime.ts` | 从这里开始 —— Pi 的 `Agent` 如何获得它的策略（约 100 行） |
| `tests/harness.e2e.test.ts` | 一个可执行场景讲完全部故事 |

## 测试

完全离线 —— 永远不需要 API 密钥：

```bash
npm test            # 115 个测试：单元、集成、E2E harness、TUI、CLI 冒烟
npm run typecheck   # 严格 TypeScript
npm run lint        # eslint
npm run build       # tsc → dist/
```

旗舰测试脚本会驱动一个确定性的 mock 模型，让**真实的** agent 循环走完
`bash → read → edit → bash → final`，去修复一个故意写坏的 fixture 项目，
然后断言该 fixture 的测试通过、会话文件完整。MCP 集成测试会真实地启动一个
stdio 服务器进程。CI 在 Node 22 与 24 上运行同样的门禁。

## 贡献

欢迎提交 Issue 与 PR。对新代码的要求就是本项目已经坚持的标准：
小模块、明确边界、无需网络即可运行的测试。
如果一个特性需要超过约 300 行才能解释清楚，它大概应该被放进更底层的模块。

## 致谢

- [Pi](https://github.com/earendil-works/pi)（Earendil）—— 运行时基础，也是现代编码智能体最好的参考实现。
- [MiniCode](https://github.com/LiuMengxuan04/MiniCode) —— “通过搭建一个脚手架来学习”这种形式的灵感来源。

## 许可证

[MIT](./LICENSE)
