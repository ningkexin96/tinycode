TinyCode 是一个刻意保持"骨架"体量的编码智能体（Coding Agent），它的核心设计决策是：**代理循环的通用机制不自己写，全部委托给 Pi 运行时；TinyCode 自己只写围绕循环的"策略"**。本页回答一个贯穿全项目的问题——每一项能力到底来自 `@earendil-works/pi-*` 三个包，还是来自 `src/` 下的自研代码。读完本页，你将获得一张可对照源码验证的分层地图，以及三条在任何文件里都能快速判定归属的经验法则。后续各章（钩子解剖、工具体系、权限安全）都是这张地图上某条边界的放大镜视角。

Sources: [package.json](package.json#L21-L25), [ARCHITECTURE.md](ARCHITECTURE.md#L3-L4)

## 三层心智模型：表现层、策略层与内核层

先建立阅读前提：下图使用 Mermaid 的 `graph TD` 语法定义一张自上而下的有向图，节点是目录或模块，箭头表示"调用/依赖"方向。整个仓库可以切成三层——**表现层**（用户在哪里输入）、**策略层**（TinyCode 自研的全部业务规则）和**内核层**（Pi 提供的通用机制）。关键观察是：箭头只允许从上往下穿越，且策略层对内核层的介入只能通过五个明确定义的注入点完成，而不是复制或重写内核逻辑。

```mermaid
graph TD
    subgraph presentation["表现层（TinyCode 自研）"]
        CLI["src/cli<br/>参数解析 · 无头 -p 模式"]
        TUI["src/tui<br/>组件组合 · 斜杠命令 · 权限对话框"]
    end

    subgraph harness["策略层（TinyCode 自研主体）"]
        RT["TinyCodeRuntime<br/>src/agent/runtime.ts"]
        PERM["permissions<br/>分类器/规则/闸门"]
        CTX["context<br/>截断与压缩"]
        SES["session<br/>JSONL 持久化"]
        TOOLS["tools<br/>七大内置工具 + ToolRegistry"]
        MCP["mcp<br/>客户端生命周期与适配"]
        SUB["agents<br/>子代理监督"]
        SKILL["skills<br/>渐进式披露"]
        MODELREG["model<br/>提供商注册表"]
        PROMPT["agent/prompt.ts<br/>系统提示词组装"]
    end

    subgraph kernel["内核层（Pi 提供）"]
        CORE["pi-agent-core<br/>Agent 类：循环·工具调度·事件·abort"]
        AImod["pi-ai<br/>提供商目录·流式请求·参数校验"]
        TUImod["pi-tui<br/>渲染器·编辑器·滚动视图"]
    end

    CLI --> RT
    TUI --> RT
    RT -->|"五个策略钩子"| CORE
    MODELREG -->|"streamFn → streamSimple"| AImod
    TUI -.->|"仅此目录引用"| TUImod
    BOOT["bootstrap.ts 装配一切<br/>产出 Harness 对象"] -.-> harness
```

这张图直接对应仓库根目录 `ARCHITECTURE.md` 开头的 ASCII 分层图：TUI 在最上层，向下经 TinyCodeRuntime 触达 Context/Permission/Session 三个策略模块，再向下才是 Pi Agent Core；工具侧则从注册表分叉出内置工具、MCP 与子代理三个来源。

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L6-L30), [package.json](package.json#L21-L25)

## Pi 提供什么：三个包的精确分工

Pi 以三个独立 npm 包的形式被引入（版本锁定在 0.84.3），每个包负责一类完全不同的机制。理解这个分工是理解整张地图的前提：**`pi-agent-core` 管"循环"，`pi-ai` 管"模型 I/O"，`pi-tui` 管"画终端"**。此外还有一个非 Pi 依赖——官方 `@modelcontextprotocol/sdk`，它只服务于 MCP 客户端这一处。

| 包 | 提供的核心抽象 | 具体职责 | TinyCode 如何消费 |
|---|---|---|---|
| `@earendil-works/pi-agent-core` | `Agent` 类、`AgentTool`、`AgentEvent`、`StreamFn` | 拥有转录历史（`state.messages`）、执行工具、发出生命周期事件、支持 `AbortController` 中止 | `TinyCodeRuntime` 内部持有一个 `Agent` 实例并以钩子注入策略 |
| `@earendil-works/pi-ai` | `Model`、`builtinModels()`、`fauxProvider`、TypeBox 的 `Type` | 全提供商目录、环境变量鉴权、请求流式传输、工具参数 schema 校验 | 被 `ModelRegistry` 包裹后以 `streamFn` 形态交给 Agent |
| `@earendil-works/pi-tui` | `TuiAltScreen`、`Editor`、`ScrollView`、`SelectList` 等 | 终端渲染器、多行编辑器、滚动视图、覆盖对话框 | 仅在 `src/tui/` 目录内被导入，用于组件拼装 |

Sources: [package.json](package.json#L21-L25), [ARCHITECTURE.md](ARCHITECTURE.md#L32-L40), [tui/app.ts](src/tui/app.ts#L1-L11)

最容易被误判归属的是**代理循环本身**。循环（`agentLoop`）完全活在 Pi 里：流式生成一轮助手消息 → 若含工具调用则按工具的 TypeBox schema 校验参数 → 执行钩子 → 运行工具 → 追加结果 → 重复直到没有工具调用或被中止；甚至"token 截断（length stop reason）时让挂起工具调用失败而不执行残缺参数"这种边角语义也由 Pi 处理。TinyCode 对循环的贡献是**策略，不是控制流**——仓库中没有任何代码重新推导"何时停止"或"如何解析工具调用"。这是整张地图最重要的单条边界。

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L52-L61)

## 五个策略钩子：策略注入点而非控制流改写

`TinyCodeRuntime` 是全仓库唯一"触碰" `Agent` 类的地方，它只有约一百行，全部价值在于把四个构造参数钩子和一个订阅器接到 Pi 的循环上。下表列出每个钩子的位置与安装的策略——这就是策略层与内核层的**全部接触面**：

| 注入点 | 安装的策略 | 定义位置 |
|---|---|---|
| `streamFn` | 模型注册表的 `streamSimple`（带鉴权解析与 maxTokens 上限的流式函数） | [runtime.ts](src/agent/runtime.ts#L33) |
| `transformContext` | 每次请求前检查 token 预算，超限自动压缩旧对话轮次 | [runtime.ts](src/agent/runtime.ts#L43) |
| `beforeToolCall` | 权限闸门：调用 `permissions.check`，deny 时返回 `{block:true, reason}` 把拒绝理由反馈给模型 | [runtime.ts](src/agent/runtime.ts#L44-L53) |
| `afterToolCall` | 工具结果截断：超长文本保留首尾，完整输出归档为工件文件 | [runtime.ts](src/agent/runtime.ts#L54) |
| `subscribe` | 会话持久化：监听 `message_end` 事件，把每条定稿消息写入 JSONL | [runtime.ts](src/agent/runtime.ts#L57-L64) |

前置说明：下面这张 Mermaid `flowchart TD` 是一张自上而下的流程图，菱形代表判定分支。它追踪一次工具调用从 Pi 循环发起、穿越两个钩子、最终落盘的完整路径，帮助你把上表中的抽象钩子名对应到真实执行时序：

```mermaid
flowchart TD
    A["Pi agentLoop 决定执行工具调用"] --> B{"beforeToolCall：<br/>PermissionManager.check(name, args)"}
    B -- "deny" --> C["返回 block=true + reason<br/>拒绝理由作为错误工具结果回给模型"]
    B -- "allow" --> D["Pi 完成 TypeBox 参数校验<br/>执行 tool.execute（可中止）"]
    D --> E{"afterToolCall：<br/>ContextManager.handleAfterToolCall"}
    E --> F["超过 maxToolResultChars 则截断为头+尾<br/>完整输出存入 artifacts 目录"]
    F --> G["ToolResultMessage 追加进 state.messages"]
    G --> H["subscribe 回调：message_end<br/>SessionManager.record 同步追加 JSONL"]
```

注意钩子的不对称性：`transformContext` 与 `afterToolCall` 是纯函数式的上下文整形（改写"模型看到什么"），`beforeToolCall` 是门卫（决定"能不能做"），`subscribe` 是旁路观察者（只记录不干预）。五种钩子没有一种会改变循环的推进逻辑——这正是"策略层"命名的原因。`TinyCodeRuntime` 其余的方法（`prompt`、`abort`、`setModel`、`compactNow`）都只是对 `agent.state` 与 Agent 方法的薄封装，其中 `compactNow` 手动压缩时直接替换 `state.messages` 数组内容。

Sources: [runtime.ts](src/agent/runtime.ts#L31-L103), [ARCHITECTURE.md](ARCHITECTURE.md#L41-L47)

## 自研子系统全景：Harness 容器与装配顺序

策略层不是一堆散落的模块，而是由 `bootstrap.ts` 统一装配、以 **`Harness` 接口**为单一容器的整体——TUI 与无头 `-p` 模式消费的是同一个 Harness 实例。接口字段本身就是一份自研子系统清单：models、model、permissions、contextManager、runtime、tools、session、skills、mcp、subAgents 外加统一的 `shutdown()`。

Sources: [bootstrap.ts](src/bootstrap.ts#L50-L64), [cli/index.ts](src/cli/index.ts#L40-L60)

各子系统的职责一句话概括如下，它们全部属于 TinyCode 自研层：

| 子系统 | 目录 | 一句话职责 | 与内核的关系 |
|---|---|---|---|
| 模型注册表 | `src/model` | 包裹 `builtinModels()` 提供商目录，实现选择链与 mock 注入 | 包装 pi-ai，产出 `streamFn` |
| 权限系统 | `src/permissions` | shell 风险三级分类、按工具默认规则、运行时裁决闸门 | 经 `beforeToolCall` 钩子接入 |
| 上下文工程 | `src/context` | 单结果截断归档 + token 预算估算与自动压缩 | 经 `afterToolCall` / `transformContext` 接入 |
| 会话管理 | `src/session` | UUIDv7 命名的追加式 JSONL 存储、恢复与标题 | 经 `subscribe` 钩子接入 |
| 内置工具 | `src/tools` | read/write/edit/bash/grep/find/ls 七个 `AgentTool` 实现 | 实现 Pi 的 `AgentTool` 契约 |
| 技能系统 | `src/skills` | SKILL.md 发现、摘要进提示词、`load_skill` 按需加载 | 产出一个普通 `AgentTool` |
| MCP 集成 | `src/mcp` | stdio 服务器并行连接、状态记录、工具适配 | 基于官方 MCP SDK，适配成 `AgentTool` |
| 子代理监督 | `src/agents` | 只读工作线程、并发上限 3、结构化报告回收 | 为 worker 各建独立 Pi `Agent` |
| 系统提示词 | `src/agent/prompt.ts` | 组装人设、平台信息、TINY.md 记忆与技能索引 | 零 Pi 依赖的纯字符串构建 |
| TUI 组合 | `src/tui` | 组件树拼装、事件映射、斜杠命令、权限对话框 | 基于 pi-tui 组件拼装 |

Sources: [bootstrap.ts](src/bootstrap.ts#L66-L175), [ARCHITECTURE.md](ARCHITECTURE.md#L63-L73)

值得单独指出的是**统一工具注册表**这条边界线：`ToolRegistry` 本身只有三十余行，是一个禁止重名、保持注册顺序的 name→tool 映射，但它是三种来源汇合的唯一命名空间——七个内置工具最先注册，随后是技能系统的 `load_skill` 与子代理协调工具，最后 MCP 服务器启动成功后其工具也适配进来。模型因此只看到一个平坦、同质的工具表面，完全感知不到背后有几种实现来源。

Sources: [registry.ts](src/tools/registry.ts#L4-L33), [bootstrap.ts](src/bootstrap.ts#L115-L153)

## 边界判定的三条经验法则

拿到任何一个 `src/` 下的文件，如何快速判断它与 Pi 的关系？代码考古给出三条可操作的法则。

**法则一：类型穿透全局，实现各自安家。** `AgentTool` 与 `AgentMessage` 这类 Pi 类型几乎出现在每个自研模块里——因为它们是双方共享的数据契约（工具签名、消息结构），但契约的使用者与实现者仍是 TinyCode。看到 `import type { AgentTool }` 不代表该模块"属于 Pi"，只代表它遵守 Pi 的接口约定；真正的运行时行为（读文件、跑 bash、算 diff）全部写在自研文件里。

Sources: [read.ts](src/tools/read.ts#L1-L2), [manager.ts](src/session/manager.ts#L1-L2)

**法则二：看包名出现的目录分布，隔离度一目了然。** 用一条 grep 就能验证：`pi-tui` 的导入**只存在于 `src/tui/` 五个文件中**，渲染层与业务层之间没有任何泄漏——其他模块从不直接操作终端组件，而是通过 `AgentEvent` 这类中立类型通信。同理，官方 MCP SDK 只出现在 `src/mcp/client.ts` 两行导入里（`Client` 与 `StdioClientTransport`），随后立刻被适配层转写成普通 `AgentTool`，第三方依赖的影响半径被压到最小。相比之下 `pi-agent-core` 的类型遍布全仓，恰恰印证了法则一——它是契约层而非实现层。

Sources: [app.ts](src/tui/app.ts#L1-L11), [client.ts](src/mcp/client.ts#L1-L2), [adapter.ts](src/mcp/adapter.ts#L1)

**法则三：确定性规则放 Harness，不放提示词。** `prompt.ts` 的文档注释明确写道："确定性规则（权限、边界、截断）活在 harness 里，而不是提示词里"，因此这个文件没有任何 Pi 导入，只做纯字符串拼装。这是比代码依赖更深一层的边界：即便某项能力（比如"bash 危险命令要拦"）表面上通过系统提示词告知了模型，其**强制执行**也永远在策略层代码里完成——提示词只是意图声明，钩子才是执行机构。同样的思路体现在 `ModelRegistry` 上：它不重新实现任何提供商协议，只是包裹 pi-ai 的 `builtinModels()` 并叠加自研的选择链、mock 注入与 maxTokens 封顶逻辑。

Sources: [prompt.ts](src/agent/prompt.ts#L6-L18), [registry.ts](src/model/registry.ts#L19-L38), [registry.ts](src/model/registry.ts#L117-L121)

最后用仓库自带的能力归属总表收束全景——这份来自 `ARCHITECTURE.md` 结尾的清单与本页三条法则交叉验证后完全一致，可作为日后扩展时的核对基准：

| 能力 | 来源 |
|---|---|
| 代理循环、工具调度、流式事件、中止 | Pi agent-core |
| 提供商目录、环境变量鉴权、请求流式、schema 校验 | Pi ai |
| 终端渲染器、编辑器、滚动视图、覆盖列表 | Pi tui |
| 全部七个内置工具与注册表、权限三级体系、JSONL 会话、截断与压缩、系统提示词与 TINY.md、技能渐进披露、MCP 生命周期与适配（基于官方 SDK）、子代理监督、TUI 组合与斜杠命令、CLI 与配置 | TinyCode |

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L247-L262)

## 下一步阅读建议

本页建立的是"静态地图"；推荐沿两条路径深入动态行为。想看清装配顺序——即 bootstrap 如何按依赖序实例化上表中的每个子系统并塞进 Harness——请继续阅读 [Harness 装配流程：bootstrap 如何串联全部子系统](7-harness-zhuang-pei-liu-cheng-bootstrap-ru-he-chuan-lian-quan-bu-zi-xi-tong)；想逐行拆解五个钩子的实现细节，请阅读 [TinyCodeRuntime 解剖：五个策略钩子接入 Pi 代理循环](8-tinycoderuntime-jie-pou-wu-ge-ce-lue-gou-zi-jie-ru-pi-dai-li-xun-huan)。若你对地图上某条具体边界感兴趣，[统一工具注册表：内置、MCP 与子代理工具的命名空间合并](11-tong-yi-gong-ju-zhu-ce-biao-nei-zhi-mcp-yu-zi-dai-li-gong-ju-de-ming-ming-kong-jian-he-bing) 展开工具面的合并细节，[模型注册表：多提供商选择链与 Mock 模型注入](25-mo-xing-zhu-ce-biao-duo-ti-gong-shang-xuan-ze-lian-yu-mock-mo-xing-zhu-ru) 展开 pi-ai 的包装策略，而 [流式 TUI 组成：组件树、事件映射与显式重绘规则](24-liu-shi-tui-zu-cheng-zu-jian-shu-shi-jian-ying-she-yu-xian-shi-zhong-hui-gui-ze) 则展示 pi-tui 组件如何在隔离边界内被组合成完整界面。