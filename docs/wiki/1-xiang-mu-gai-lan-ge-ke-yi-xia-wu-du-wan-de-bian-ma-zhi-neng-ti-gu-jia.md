本页是整个文档站的起点，回答三个问题：TinyCode 是什么、它为什么值得初学者通读源码、以及它的整体架构长什么样。读完本页你不需要理解任何一行具体实现——只需要建立一张"心智地图"，知道每个子系统住在哪里、彼此如何衔接。后续章节会逐一深入这些子系统，本页只负责指路。

Sources: [README.md](README.md#L3-L17)

## TinyCode 是什么：与生产级智能体"反着设计"

TinyCode 的官方定位是 **"一个极简但完整的编码智能体骨架（Coding Agent Harness）"**。这里的 *Harness* 可以理解为"马具"——它本身不包含智能，而是把模型、工具、权限、会话这些部件套在一起的那副骨架。市面上大多数编码智能体是产品：几十万行代码、闭源或过度膨胀，根本无法装进脑子里；TinyCode 反其道而行之，目标是**一个下午就能读完全部源码**，同时保留生产级智能体的每一个关键子系统：

```
Model + Agent Loop + Tools + Permissions + Session
+ Context Engineering + Skills + MCP + Sub-Agents + TUI
```

这十个部件不是玩具演示——它基于 [Pi](https://github.com/earendil-works/pi) 运行时构建，循环真的在流式输出、工具真的在执行、会话真的在落盘。项目自述约 6k 行代码"每一行都值得阅读"，实测 `src/` 目录 TypeScript 源码共 4,647 行，加上测试约 7 千行，与自述量级一致。

Sources: [README.md](README.md#L20-L28), [package.json](package.json#L26-L31)

它与同类项目的对比可以帮你快速定位学习价值。注意最后一列：Claude Code 这类产品虽然强大，但对想理解原理的初学者并不友好（闭源或体积过大）；而 TinyCode 在"完整子系统"与"可读性"之间取得了罕见的平衡。

| 项目 | 语言 | 定位 | 作为第一个可读对象？ |
|---|---|---|---|
| **TinyCode** | TypeScript | 完整的教学型智能体骨架 | ✅ 约 6k 行，附导读文档 |
| Claude Code | TypeScript | 生产级智能体产品（闭源） | ✗ 内部不可考 |
| OpenAI Codex CLI | Rust | 生产级智能体 CLI | ⚠️ 体量大 |
| OpenCode | TS + Go | 生产级 IDE/CLI | ⚠️ 多进程架构 |
| pi coding-agent | TypeScript | Pi 全功能智能体 | ✅ 适合作为 TinyCode 之后的一站 |

Sources: [README.md](README.md#L60-L82)

## 为什么"一下午能读完"不是营销话术

判断一份代码能否在一个下午读完，最直接的证据是**单文件体量分布**。TinyCode 全库最大的文件是 TUI 主程序 `app.ts`（396 行），第二大是装配入口 `bootstrap.ts`（242 行）——绝大多数模块的单个文件不超过 170 行，这意味着你在任何时刻只需要在脑子里同时持有不到两百行代码的逻辑。下表是实测的分模块代码量：

| 模块目录 | 行数 | 职责一句话 |
|---|---|---|
| `src/tools` | 1,028 | 七大内置工具 + 统一注册表 + 工作区路径守卫 |
| `src/tui` | 950 | 流式终端界面（最大单文件 app.ts 为 396 行）|
| `src/cli` | 406 | 命令行入口、参数解析、一次性模式 |
| `src/permissions` | 384 | Shell 风险三级分类 + 权限裁决闸门 |
| `src/agents` | 337 | 只读子代理监督（最多 3 个并发）|
| `src/mcp` | 259 | stdio MCP 服务器连接与工具适配 |
| `src/context` | 232 | 工具结果截断 + Token 预算自动压缩 |
| `src/session` | 225 | 追加式 JSONL 会话持久化 |
| `src/agent` | 167 | 运行时策略钩子 + 系统提示词生成 |
| `src/skills` / `src/config` / `src/model` | 139–417 | 技能发现 / 配置加载 / 模型选择链 |

这个分布本身就透露了设计哲学：工具和界面（交互最多的部分）占大头，而核心运行时 `agent` 目录只有 167 行——因为复杂的控制流被委托给了底层的 Pi 库，TinyCode 自己只写**策略**。

Sources: [README.md](README.md#L109-L134), [src/agent/runtime.ts](src/agent/runtime.ts#L28-L31)

## 架构鸟瞰：先看地图，再进森林

在阅读下面的架构图之前，先解释两个图中会出现的术语。**Agent Loop（代理循环）**指模型驱动的"流式响应 → 发起工具调用 → 执行工具 → 把结果喂回模型 → 重复直到不再调用工具"这一循环过程；**注册表（Registry）**则是一个"名字 → 工具实现"的映射表，让模型面对统一的工具接口。理解这两点后，整张图就是一条清晰的分层链路：

```mermaid
flowchart TD
    TUI["TUI 界面层<br/>src/tui"]
    RT["TinyCode 运行时<br/>src/agent/runtime.ts"]
    CTX["上下文管理<br/>src/context"]
    PERM["权限闸门<br/>src/permissions"]
    SESS["会话持久化<br/>src/session"]
    CORE["Pi Agent Core 循环<br/>pi-agent-core"]
    MODEL["模型接入<br/>pi-ai + src/model"]
    REG["统一工具注册表<br/>src/tools/registry.ts"]
    BUILTIN["内置工具 × 7<br/>read/edit/bash/grep/find/ls/write"]
    MCP["MCP 外部工具<br/>src/mcp"]
    SUB["子代理工具 × 4<br/>src/agents"]

    TUI --> RT
    RT --> CTX
    RT --> PERM
    RT --> SESS
    RT --> CORE
    CORE --> MODEL
    CORE --> REG
    REG --> BUILTIN
    REG --> MCP
    REG --> SUB
```

这张图对应仓库中 `ARCHITECTURE.md` 开头的 ASCII 示意：TUI 在最上层接收你的输入，交给 TinyCode 运行时；运行时把三条策略（上下文、权限、会话）挂到 Pi 提供的代理循环上；循环执行工具时，所有来源的工具（内置、MCP、子代理）都汇入同一个注册表，对模型呈现统一接口。

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L8-L29), [ARCHITECTURE.md](ARCHITECTURE.md#L63-L92)

## 核心接缝：TinyCodeRuntime 与五条策略钩子

整个项目最精妙的设计浓缩在一个仅 102 行的文件里。Pi 的 `Agent` 类提供了若干**钩子位**——即在循环的关键节点允许外部插入自定义逻辑的空槽。`TinyCodeRuntime` 往这五个槽里各塞了一条策略，就完成了全部"胶水工作"：

| 钩子 | 安装的策略 |
|---|---|
| `streamFn` | 来自模型注册表的认证流式函数 |
| `beforeToolCall` | 权限闸门——可以带理由拦截工具调用 |
| `afterToolCall` | 工具结果截断（上下文卫生）|
| `transformContext` | 每次请求前压缩过大的历史记录 |
| `subscribe` | 将每条定稿消息写入会话文件 |

换句话说，TinyCode **不重新发明"何时停止""如何解析工具调用"这类控制流**，只注入"何时放行""如何瘦身上下文"这类策略。这也是为什么运行时能薄到百行以内——复杂度被正确地留在了底层库里。

Sources: [src/agent/runtime.ts](src/agent/runtime.ts#L8-L15), [src/agent/runtime.ts](src/agent/runtime.ts#L31-L64)

## 职责边界：Pi 给了什么，TinyCode 写了什么

对于初学者，分清"哪些能力是借来的、哪些是自己写的"能避免最大的阅读误区——以为某段精巧逻辑是本项目实现的。仓库的架构文档末尾给出了一张明确的分工总表，此处摘录其主干：

| 能力 | 来源 |
|---|---|
| 代理循环、工具分发、流式事件、中断 | Pi agent-core |
| 提供商目录、环境变量认证、请求流式传输 | Pi ai |
| 终端渲染器、编辑器、滚动视图 | Pi tui |
| 全部 7 个编码工具与注册表 | **TinyCode 自研** |
| 权限分类器/规则/闸门/对话框 | **TinyCode 自研** |
| JSONL 会话、恢复、标题 | **TinyCode 自研** |
| 截断、预算、压缩等上下文工程 | **TinyCode 自研** |
| 技能发现、MCP 生命周期、子代理监督、CLI 与配置 | **TinyCode 自研** |

规律很清晰：**凡是与"智能体控制流"相关的底层机制来自 Pi，凡是与"产品行为和安全"相关的上层策略由 TinyCode 实现**。这一边界的详细论证见后续章节。

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L247-L263)

## 启动时发生什么：装配流程一瞥

当你敲下 `tinycode` 回车后，`bootstrap.ts`（全库第二大的文件，也才 242 行）按固定顺序把所有子系统组装成一个 `Harness` 对象：解析并选择模型（支持 Mock 零配置模式）→ 初始化权限管理器 → 配置上下文策略 → 发现技能 → 创建或恢复会话 → 注册七大内置工具与 `load_skill` → 组装只读子代理工具 → 连接 MCP 服务器 → 读取 `TINY.md` 项目记忆生成系统提示词 → 最后用这一切构造 `TinyCodeRuntime`。无论交互式 TUI 还是无头一次性模式，都复用同一个装配产物。

Sources: [src/bootstrap.ts](src/bootstrap.ts#L36-L64), [src/bootstrap.ts](src/bootstrap.ts#L115-L166)

值得一提的是安全姿态：TinyCode 明确声明自己的权限系统是**审批层加工作区路径守卫，而非操作系统沙箱**——被批准的 bash 命令可以做你用户能做的一切事。API 密钥只从环境变量读取，配置文件中出现疑似密钥的字段会在启动时大声警告。这种坦诚的边界声明在教学项目中尤为可贵。

Sources: [README.md](README.md#L156-L168)

## 测试也是教学材料

TinyCode 的测试策略本身就是一堂课：全部测试离线运行，永远不需要 API Key。旗舰 E2E 测试用脚本化的 Mock 模型驱动**真实的**代理循环走完 `bash → read → edit → bash → 最终答复` 流程，修复一个故意写坏的 fixture 项目，然后断言 fixture 的测试通过、会话文件完整。CI 在 Node 22 和 24 双版本上跑同样的质量门禁。读源码卡壳时，对应的测试文件往往是最直白的用法示例。

Sources: [README.md](README.md#L178-L192)

## 建议的阅读路径

按照认知负荷递增的顺序，推荐如下阅读路线：

1. **动手跑起来** —— 先安装构建并用 `TINYCODE_MODEL=mock` 零配置体验一次真实运行，建立直观感受：[快速开始：安装、构建与 Mock 模式零配置运行](2-kuai-su-kai-shi-an-zhuang-gou-jian-yu-mock-mo-shi-ling-pei-zhi-yun-xing)
2. **了解日常操作面** —— 配置文件与环境变量的约定见[配置体系：config.json、环境变量与密钥安全管理](3-pei-zhi-ti-xi-config-json-huan-jing-bian-liang-yu-mi-yao-an-quan-guan-li)，界面操作见[交互式 TUI 使用指南：快捷键、输入与斜杠命令](4-jiao-hu-shi-tui-shi-yong-zhi-nan-kuai-jie-jian-shu-ru-yu-xie-gang-ming-ling)
3. **进入深水区** —— 从分层职责边界的正式论证开始：[分层架构地图：Pi 运行时与 TinyCode 自研层的职责边界](6-fen-ceng-jia-gou-di-tu-pi-yun-xing-shi-yu-tinycode-zi-yan-ceng-de-zhi-ze-bian-jie)，随后逐行读懂装配过程：[Harness 装配流程：bootstrap 如何串联全部子系统](7-harness-zhuang-pei-liu-cheng-bootstrap-ru-he-chuan-lian-quan-bu-zi-xi-tong)
4. **解剖核心** —— 五条钩子的逐行解读在[TinyCodeRuntime 解剖：五个策略钩子接入 Pi 代理循环](8-tinycoderuntime-jie-pou-wu-ge-ce-lue-gou-zi-jie-ru-pi-dai-li-xun-huan)；之后可按兴趣跳转工具体系（[七大内置工具详解：read/edit/bash 等的行为契约](10-qi-da-nei-zhi-gong-ju-xiang-jie-read-edit-bash-deng-de-xing-wei-qi-yue)）、权限安全（[权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-ji-yi-mo-shi-auto-yu-ask-hui-tui)）或扩展机制（[MCP 集成：stdio 服务器并行连接与单点故障隔离](22-mcp-ji-cheng-stdio-fu-wu-qi-bing-xing-lian-jie-yu-dan-dian-gu-zhang-ge-chi)）
5. **收官** —— 用离线测试策略串起全部知识：[全离线测试策略：脚本化 Mock 模型驱动真实代理循环的 E2E](26-quan-chi-xian-ce-shi-ce-lue-jiao-ben-hua-mock-mo-xing-qu-dong-zhen-shi-dai-li-xun-huan-de-e2e)

Sources: [README.md](README.md#L170-L176), [ARCHITECTURE.md](ARCHITECTURE.md#L32-L50)

一张图总结本页要点：TinyCode 用不到五千行源码证明了"生产级智能体的每个子系统都可以写得足够小、足够清楚"。接下来，让我们把它真正跑起来。