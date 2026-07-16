TinyCode 对模型暴露的工具面只有一个：一张扁平的 `Map<string, AgentTool>`。无论工具来自内置工厂函数、技能系统的 `load_skill`、子代理监督指令，还是外部 MCP 服务器，最终都汇入同一个 `ToolRegistry` 实例——模型在提示词中看到的是一份连续、有序、无嵌套命名空间的工具清单。本页解释这张注册表的结构、四段式装配顺序如何决定命名优先级、MCP 工具的冲突改写算法，以及工作线程为何刻意使用另一张独立的注册表。

## 一个 Map 撑起的统一工具面：注册表本体

`ToolRegistry` 的实现只有三十余行，核心约束有两条。其一是**唯一性 fail-fast**：`register()` 在发现重名时直接抛出异常而非静默覆盖，这保证了任何两个工具源之间的命名冲突都不可能被掩盖，必须由调用方显式消解后才能进入注册表。其二是**插入序稳定**：底层使用 `Map` 天然保留插入顺序，`list()` 按 `values()` 展开返回，注释明确说明这是为了"稳定的提示词/工具列表"——模型每次会话看到的工具顺序完全一致，有利于工具调用的可复现性。

```mermaid
flowchart LR
    subgraph 工具源["三类工具源"]
        A["内置七工具<br/>read/write/edit/bash/grep/find/ls"]
        B["load_skill + 子代理监督四工具<br/>spawn/list/wait/close_agent"]
        C["MCP 远程工具<br/>经 adapter 冲突改写"]
    end
    R["ToolRegistry<br/>Map&lt;name, AgentTool&gt;<br/>重名即抛错 · 保插入序"]
    subgraph 消费方["统一消费面"]
        D["Pi Agent initialState<br/>tools.list()"]
        E["权限闸门<br/>toolCall.name 分流"]
        F["TUI 状态栏<br/>names() 展示"]
    end
    A --> R
    B --> R
    C --> R
    R --> D
    R --> E
    R --> F
```

值得注意的是，注册表本身对工具类型零感知：它只存储符合 Pi 运行时 `AgentTool` 接口的对象，MCP 的远程调用语义、子代理的并发控制都被封装在各工具自己的 `execute` 闭包里。这种"注册表薄、适配层厚"的分层让新增第四类工具源时不需要触碰注册表代码。

Sources: [registry.ts](src/tools/registry.ts#L10-L28)、[index.ts](src/tools/index.ts#L1-L9)

## 四段式装配顺序：命名优先级由注册先后决定

`bootstrapHarness` 中对注册表的填充严格分四段进行，这个顺序不只是代码组织习惯——它直接决定了命名冲突时谁"保住原名"。由于内置工具最先注册且注册表拒绝重复，后续所有来源遇到重名时只能让步改写；又因为 `list()` 保持插入序，模型提示词中的工具排列也遵循同一顺序。

| 装配阶段 | 注册内容 | 数量 | 命名特征 |
|---|---|---|---|
| ① 内置工具 | read, write, edit, bash, grep, find, ls | 7 | 固定短名，永不让步 |
| ② 技能入口 | load_skill | 1 | 固定名，配合系统提示词中的技能摘要 |
| ③ 子代理监督 | spawn_agent, list_agents, wait_agent, close_agent | 4 | 固定 `_agent` 后缀风格 |
| ④ MCP 远程 | 各服务器声明的工具 | 0..n | 冲突时改写为 `<服务器名>_<工具名>` |

第三段有一个容易被忽略的设计细节：监督工具虽然进入了主注册表供根代理使用，但传给 `SubAgentManager` 的 `workerTools` 是一个独立数组——bootstrap 用同样的四个只读工厂（read/grep/find/ls）重新创建了一套实例，而不是从注册表中筛选。这意味着工作线程的工具集与主注册表是两条完全独立的供给线，后文将展开其隔离意义。第四段 MCP 注册前还有一道前置条件：只有配置了 `mcpServers` 且 `startAll()` 并行连接完成后才执行，连接失败的服务器不会产生任何工具条目。

Sources: [bootstrap.ts](src/bootstrap.ts#L115-L153)

## MCP 工具的适配层：冲突改写与透明包装

`registerMcpTools` 是整个命名空间合并中唯一执行"改写"逻辑的地方，其算法可以概括为一个三步决策：

```mermaid
flowchart TD
    S["遍历已连接服务器的缓存工具列表"] --> C1{"registry.has(原始名)?"}
    C1 -- 否 --> OK["以原始名注册<br/>如 fail"]
    C1 -- 是 --> P["改写为 服务器名_工具名<br/>如 echo → test-mcp_echo"]
    P --> C2{"registry.has(改写名)?"}
    C2 -- 否 --> OK2["以前缀名注册"]
    C2 -- 是 --> SKIP["病态双重碰撞：<br/>静默跳过该工具"]
    OK --> N["计数 +1"]
    OK2 --> N
```

测试套件为这条决策链提供了精确契约：mock MCP 服务器提供 `echo` 和 `fail` 两个工具，测试先向注册表手工注册一个名为 `echo` 的内置工具模拟真实冲突，随后断言注册结果恰好为 `["echo", "fail", "test-mcp_echo"]`——内置 `echo` 保住原名，远程 `echo` 被改写，无冲突的 `fail` 保持原样，计数为 2。

改写只是合并的一半，另一半是**包装**。`mcpToolToAgentTool` 把每个远程工具翻译成标准 `AgentTool`：`label` 标注为 `MCP 服务器名/远程名` 以便 TUI 区分展示；描述文本被追加来源标注（`(MCP tool provided by server "...")`）帮助模型理解出处；最关键的是 `execute` 闭包捕获了"注册名 → 服务器名 + 远程名"的映射——模型始终用合并后的名字调用，运行时再解回真实的远端标识。调用结果统一映射为 `{ mcpServer, mcpTool, isError }` 三元组放入 `details`，错误语义不丢失。此外 `normalizeSchema` 兜底保证每个 MCP 工具的参数都是合法 object 形状的 JSON Schema，防御远端返回畸形定义。

Sources: [adapter.ts](src/mcp/adapter.ts#L12-L58)、[mcp.test.ts](tests/mcp.test.ts#L32-L60)、[manager.ts](src/mcp/manager.ts#L30-L65)

## 子代理的命名空间隔离：监督工具进主表，工作线程另起一张表

子代理体系在命名空间上呈现"一进一出"的不对称结构。**进的**是四个监督工具：`spawn_agent`、`list_agents`、`wait_agent`、`close_agent` 作为普通 `AgentTool` 注册进主注册表，与内置工具同场竞技，根代理因此能用与其他工具完全一致的调用方式管理工作线程。源码注释点明了安全边界："工作线程自身永远不会收到这些工具，因此递归不可能发生"。

**出的**则是工作线程的独立注册表。`WorkerAgent` 内部新建了一个全新的 `ToolRegistry` 实例（`readonly registry = new ToolRegistry()`），仅装入 bootstrap 传入的四个只读工具实例，并且配套 `mode: "auto"` 的权限管理器自动放行——因为工作线程内不存在审批对话框。这张表里没有 `bash`、没有 `write/edit`、没有监督工具、也没有任何 MCP 工具，工作线程从结构上就无法越界修改文件或派生后代。

```mermaid
flowchart TB
    subgraph 主命名空间["主注册表（根代理可见）"]
        direction LR
        BI["read · write · edit · bash<br/>grep · find · ls"] 
        SA["spawn_agent · list_agents<br/>wait_agent · close_agent"]
        LS["load_skill"]
        MCP["MCP 工具（改写名）"]
    end
    SA -->|"spawn()"| W["WorkerAgent"]
    subgraph 工作线程命名空间["WorkerAgent.registry（独立实例）"]
        RO["read · grep · find · ls<br/>（全新实例 + auto 权限）"]
    end
    W -.->|"结构上不含"| X["✗ write/edit/bash/MCP/监督工具"]
```

这个设计回答了一个架构问题：为什么不用前缀过滤（比如给工作线程发全量注册表但屏蔽部分名字）？因为"黑名单式"隔离依赖每个消费方正确执行过滤，而"白名单式"独立注册表把隔离固化在数据结构里——工作线程的 Agent 循环拿到的 `tools.list()` 天然只有四个元素，无需任何额外检查。

Sources: [tools.ts](src/agents/tools.ts#L7-L81)、[worker.ts](src/agents/worker.ts#L33-L41)、[bootstrap.ts](src/bootstrap.ts#L131-L144)

## 统一消费面：模型、TUI 与权限闸门共享同一命名

注册表的价值在于三个异质消费方都只需面对同一个名字集合。首先是模型侧：`TinyCodeRuntime` 构造 Pi `Agent` 时直接传入 `options.tools.list()`，统一注册表就是模型的全部工具视野，模型无需知道某个名字背后是本地闭包还是 stdio 进程。其次是 TUI 侧：斜杠命令的状态展示用 `tools.names().join(", ")` 输出整张注册表的键列表，用户能一眼核对当前会话实际加载了哪些工具（包括 MCP 改写后的名字）。最后是权限侧：每次工具调用的 `beforeToolCall` 都以 `toolCall.name` 进入 `PermissionManager.check`，权限规则按**精确名字**分流——`write`/`edit` 触发路径校验加 ASK，`bash` 先过硬拒绝清单再走风险分类，而 `load_skill`、四个监督工具以及大多数 MCP 工具因不在特判名单中而落入默认模式处理。这正是统一命名的隐性收益：一套权限闸门无需为不同工具源维护不同的判定入口。

Sources: [runtime.ts](src/agent/runtime.ts#L34-L46)、[slash.ts](src/tui/slash.ts#L148)、[rules.ts](src/permissions/rules.ts#L76-L89)

## 设计权衡：为什么是"前缀改写"而不是别的方案

命名空间合并有多种业界常见做法，TinyCode 的取舍值得放在对比中理解：

| 方案 | TinyCode 的选择 | 被放弃的替代 | 取舍理由 |
|---|---|---|---|
| 冲突检测 | `register()` 重名抛错 | 静默覆盖 | 让冲突在装配期暴露，而非运行时产生难以追踪的行为替换 |
| 冲突消解 | MCP 工具加 `<server>_` 前缀 | 全部强制前缀（如 `mcp__server__tool`） | 无冲突时保留短名，降低模型调用出错率；前缀仅在必要时出现 |
| 双重碰撞 | 跳过该工具并继续 | 启动失败 | 与 MCP 层"故障记录但不致命"的整体策略一致 |
| 工具面形态 | 单一扁平命名空间 | 嵌套分组/按源切换 | 模型一次看到全部能力，避免多注册表路由复杂度 |
| 工作线程隔离 | 独立注册表白名单 | 同一注册表+名字过滤 | 隔离内建于数据结构，不依赖过滤逻辑的正确性 |

其中"双重碰撞跳过"是最务实的一处：当 `echo` 和 `test-mcp_echo` 都已被占用时（例如两台同名服务器各提供一个 `echo`），继续注册只会制造不可预测的覆盖，而中止整个启动则让一个边缘病理案例绑架可用性。跳过并保留其余工具，把损失限制在单个条目。

Sources: [adapter.ts](src/mcp/adapter.ts#L14-L25)、[bootstrap.ts](src/bootstrap.ts#L146-L153)

## 小结与延伸阅读

统一工具注册表是 TinyCode "单一工具面"哲学的物化：一张保序的 Map、一个 fail-fast 的 `register`、一段只在 MCP 适配层出现的改写逻辑，加上工作线程的一张刻意的孤岛表，共同构成既开放（任意来源皆可接入）又封闭（重名绝不容忍）的命名空间。理解了这张表，你就能准确推断出任何一次工具调用从模型发出到执行的完整路径。

建议按以下顺序继续深入：

- 了解七个内置工具各自的行为契约，见 [七大内置工具详解：read/edit/bash 等的行为契约](10-qi-da-nei-zhi-gong-ju-xiang-jie-read-edit-bash-deng-de-xing-wei-qi-yue)
- 回看这张注册表在整体装配流程中的位置，见 [Harness 装配流程：bootstrap 如何串联全部子系统](7-harness-zhuang-pei-liu-cheng-bootstrap-ru-he-chuan-lian-quan-bu-zi-xi-tong)
- 深入 MCP 连接生命周期与单点故障隔离，见 [MCP 集成：stdio 服务器并行连接与单点故障隔离](22-mcp-ji-cheng-stdio-fu-wu-qi-bing-xing-lian-jie-yu-dan-dian-gu-zhang-ge-chi)
- 展开子代理监督机制的完整细节，见 [子代理监督：只读工作线程、并发上限与结构化报告回收](23-zi-dai-li-jian-du-zhi-du-gong-zuo-xian-cheng-bing-fa-shang-xian-yu-jie-gou-hua-bao-gao-hui-shou)
- 追踪统一名字进入权限闸门后的完整裁决链，见 [权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)