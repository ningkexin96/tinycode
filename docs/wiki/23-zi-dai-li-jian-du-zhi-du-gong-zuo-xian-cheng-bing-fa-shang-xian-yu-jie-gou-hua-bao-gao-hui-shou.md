TinyCode 的子代理系统由三个文件构成一个完整的监督闭环：`WorkerAgent` 提供与根对话完全隔离的只读研究实例，`SubAgentManager` 以"超限即拒绝"的策略约束并发数量，而四个根代理工具（`spawn_agent` / `list_agents` / `wait_agent` / `close_agent`）则构成结构化报告的提交与回收界面。本页面向高级读者，剖析这套机制如何在不引入操作系统级线程或进程的前提下，用纯异步对象实现"蜂群失控防护 + 单向数据流回收"。所有论断均以仓库内可验证代码为依据。

Sources: [worker.ts](src/agents/worker.ts#L1-L66), [manager.ts](src/agents/manager.ts#L1-L150), [tools.ts](src/agents/tools.ts#L1-L96)

## 隔离模型：独立代理实例，而非线程

首先要澄清标题中的"工作线程"一词：这里的 worker 不是 OS 线程，而是一个**独立的 Pi Agent 实例**。每个 `WorkerAgent` 拥有自己的 `ToolRegistry`、自己的 `PermissionManager`、自己的 `ContextManager` 和自己的转录历史，代码注释明确声明它"与根对话不共享任何可变状态"，并通过 `Agent.abort` 获得专属的 AbortController。所谓"并发"，本质上是多个 Promise 同时驱动各自独立的代理循环——隔离边界是内存中的对象图，而不是执行栈。

```mermaid
graph TD
    Root["根代理 TinyCodeRuntime<br/>完整工具集 + 权限闸门"]
    Registry["统一 ToolRegistry"]

    subgraph Tools ["根代理监督工具（仅注册给根）"]
        T1["spawn_agent"]
        T2["list_agents"]
        T3["wait_agent"]
        T4["close_agent"]
    end

    Manager["SubAgentManager<br/>maxConcurrent = 3"]

    subgraph Workers ["WorkerAgent × N（互相不可见）"]
        W1["Worker A<br/>read/grep/find/ls<br/>auto 权限 · 独立转录"]
        W2["Worker B<br/>同左"]
    end

    Model["模型 streamFn（共享）"]

    Root --> Registry --> Tools --> Manager --> W1 & W2
    W1 & W2 -.-> Model
    Manager -- "WorkerReport[]" --> T3
```

图中有一条关键的**结构性单向边**：监督工具只被注册进根代理的注册表（bootstrap 中 `for (const tool of createSubAgentTools(subAgents)) tools.register(tool)`），而 worker 构造时接收的工具白名单里根本没有这些工具。因此"子代理不能再孵化子代理"不是靠运行时检查实现的，而是靠装配时的工具集划分从结构上杜绝了递归。

Sources: [worker.ts](src/agents/worker.ts#L27-L65), [tools.ts](src/agents/tools.ts#L5-L9), [bootstrap.ts](src/bootstrap.ts#L130-L144)

## 只读边界的四层构造

worker 的"只读"承诺由四道彼此独立的防线叠加保证，任何一道单独失效都不会破坏整体语义。第一道是**工具白名单**：装配处硬编码了恰好四个工厂函数——`createReadTool`、`createGrepTool`、`createFindTool`、`createLsTool`——刻意排除了 write/edit/bash/load_skill 以及一切 MCP 工具。第二道是**权限模式**：worker 内部创建 `PermissionManager({ mode: "auto", projectRoot })`，注释解释这是"worker 自动批准其只读工具；它们内部不存在对话框"——因为 worker 没有任何交互面可以承载审批 UI，若沿用 ASK 模式将导致永久挂起。

第三道是**上下文策略的差异**：worker 的 `ContextManager` 配置为 `maxToolResultChars: 20_000` 但 `compactAboveTokens: 0`，即保留截断却永不自动压缩；注释给出的理由值得细读——"worker 转录短命，有损摘要会污染进行中的调查"。连兜底 summarizer 也被替换为恒等截断函数 `transcript.slice(0, 2000)`。第四道是**系统提示词**：`WORKER_SYSTEM_PROMPT` 将角色定义为"孤立的只读子代理"，限定其输出格式为"发现了什么（事实、文件路径、行引用）+ 与父问题的相关性评估 + 别无其他"，并明确告知它不能修改文件、不能执行命令、必须在单次回复中完成。

| 维度 | 根代理 | WorkerAgent |
|------|--------|-------------|
| 工具集 | 七大内置工具 + load_skill + MCP + 子代理监督工具 | 仅 read / grep / find / ls |
| 权限模式 | 记忆模式 / auto / ASK 回退（含 TUI 对话框） | 固定 `auto`，无审批界面 |
| 自动压缩 | Token 超阈值触发摘要压缩 | 永不压缩（`compactAboveTokens: 0`） |
| Summarizer | 默认 LLM 摘要调用 | 恒等截断 `slice(0, 2000)` |
| 会话持久化 | JSONL 落盘 | 无（转录随生命周期消亡） |
| 可孵化的子代理 | 可以 | 不可能（未注册监督工具） |

Sources: [bootstrap.ts](src/bootstrap.ts#L131-L143), [worker.ts](src/agents/worker.ts#L9-L17), [worker.ts](src/agents/worker.ts#L40-L49)

## 并发上限：拒绝语义而非排队语义

`SubAgentManager` 的默认并发帽为 3（`options.maxConcurrent ?? 3`），且 bootstrap 装配时显式传入 `maxConcurrent: 3`，TUI 状态栏同样硬编码 `agentsMax: 3`——三处一致说明这是一个当前不可配置的设计常量。`spawn()` 在真正创建 worker 前依次执行三段校验：名称合法性（正则 `/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,39}$/` 要求 1–40 字符且不以连字符或下划线开头）、名称唯一性（重名直接抛错并建议换名或先关闭），最后才是并发检查。

并发检查的实现是**抛错而非入队**：当 `runningCount >= this.maxConcurrent` 时，错误消息会指导调用方下一步动作——"使用 wait_agent 收集结果，或 close_agent 释放槽位"。这个设计把决策权交还给根代理的推理循环：与其让请求在队列中静默积压，不如让模型立刻看到失败并根据提示调整策略。测试用例精确锁定了这一契约：容量为 1 时第二次 spawn 抛出 `/concurrency limit/`，而在 `wait()` 完成后同一名字可以成功再次孵化——证明**已结算（settled）的 worker 不占用槽位**，`runningCount` 只统计 `status === "running"` 的句柄。

```mermaid
stateDiagram-v2
    [*] --> running : spawn_agent（通过三段校验）
    running --> completed : prompt 正常返回<br/>report = 最终助手文本
    running --> aborted : close_agent 或 shutdown<br/>signal.aborted 为真
    running --> error : prompt 抛出异常<br/>report = Worker failed: …
    completed --> [*]
    aborted --> [*]
    error --> [*]
```

状态机中有两个细节值得注意。其一，`spawn` 是**发射后不管**的：内部异步 IIFE 驱动整个生命周期，原地修改共享的 `report` 对象，方法本身同步返回初始 `running` 快照供工具回显。其二，`durationMs` 在 `finally` 块中记录，无论三种终态哪一种都会留下耗时证据；`wait()` 通过 `Promise.all` 挂在每份 `finished` promise 上，无参调用时过滤掉所有已结算句柄、等待其余全部完成。

Sources: [manager.ts](src/agents/manager.ts#L29-L49), [manager.ts](src/agents/manager.ts#L57-L84), [manager.ts](src/agents/manager.ts#L86-L126), [subagents.test.ts](tests/subagents.test.ts#L76-L91), [app.ts](src/tui/app.ts#L226-L238)

## 结构化报告：固定 Schema 与最终文本提取

报告回收的数据载体是 `WorkerReport` 接口，六个字段构成了根代理与 worker 之间唯一的正式契约：

| 字段 | 类型 | 含义 |
|------|------|------|
| `id` | `string` | 自增 ID：`w{计数器36进制}{4位随机}`，形如 `w1k3x2` |
| `name` | `string` | 孵化时指定的唯一人类可读名 |
| `task` | `string` | 原始调查任务描述 |
| `status` | `"running" \| "completed" \| "aborted" \| "error"` | 四态生命周期 |
| `report` | `string` | 终态文本负载 |
| `durationMs` | `number` | 从孵化到结算的毫秒数 |

`report` 字段的填充规则由 `finalAssistantText` 决定：它从转录消息数组**尾部倒序**扫描，找到第一条含非空文本的 assistant 消息后拼接其 text 片段返回。这个"取最后一次发言"的语义与系统提示词中"必须在单次回复中完成"形成配合——提示词约束模型行为，提取器假设该约束成立。防御性分支覆盖了两种退化情形：assistant 消息存在但文本为空时回退到 `(assistant error: ...)`；整条转录没有任何 assistant 输出时返回 `(no response)`。这意味着即便模型彻底失格，回收到的仍是一个非空字符串而非 `undefined`。

`wait_agent` 工具将多份报告聚合为人类与模型都可读的分节文本：每节首行是 `[✓ completed] 名称 (X.Xs)` 格式的状态头（符号由 `statusLabel` 映射：`●` 运行中、`✓` 完成、`■` 中止、`✗` 出错），随后换行接报告正文。值得注意的是 `reports()` 返回的是展开拷贝 `{ ...handle.report }`，防止外部持有者绕过管理器改写内部状态——但这也意味着调用方拿到的是某一时刻的快照，运行中的报告内容必然为空串，真正的负载只能经 `wait()` 结算后获得。

Sources: [types.ts](src/agents/types.ts#L4-L28), [manager.ts](src/agents/manager.ts#L101-L149), [tools.ts](src/agents/tools.ts#L55-L75)

## 监督工具面：四个动词构成的完整协议

根代理对子代理的全部控制收敛于四个工具，每个对应协议中的一个动词：

| 工具 | 参数 | 同步/异步 | 行为要点 |
|------|------|-----------|----------|
| `spawn_agent` | `name`, `task` | 同步返回 | 校验失败抛错；成功返回含 ID 与状态行的确认文本 |
| `list_agents` | 无 | 同步返回 | 列出所有 worker 及状态符号；空时提示从未孵化过 |
| `wait_agent` | `agent_id?` | 异步阻塞 | 按 id **或名称**定位单个 worker；省略参数则等待全部未结算者 |
| `close_agent` | `agent_id` | 同步发起 | 对目标 runtime 调 `abort()`，中止是协作式的 |

两个工程细节体现了接口的人体工学考量。一是 `requireWorker` 同时接受 id 和 name 匹配，找不到时抛出的错误消息会引导模型先调用 `list_agents` 查看活跃列表——错误消息本身就是 API 文档的一部分。二是 `close_agent` 的返回文本措辞是"abort requested"而非"aborted"：`runtime.abort()` 只是发出中止信号，实际状态翻转发生在 worker 循环检测到 `signal.aborted` 之后，因此调用方需要后续 `wait` 才能确认终态。测试对此的断言也相应宽松——接受 `"aborted"` 或 `"completed"` 两种结局，承认中止信号与循环退出之间存在竞态窗口。

Sources: [tools.ts](src/agents/tools.ts#L10-L94), [manager.ts](src/agents/manager.ts#L116-L121), [subagents.test.ts](tests/subagents.test.ts#L93-L104)

## 装配、可见性与收尾顺序

子代理子系统在 bootstrap 中的装配位置刻意安排在**内置工具之后、MCP 之前**：此时七大内置工具工厂已经注册完毕，worker 白名单可以直接复用同一批工厂函数生成独立实例；而 MCP 工具尚未进入注册表，天然不可能泄漏进 worker 工具集。管理器连同四个监督工具一起挂载到 harness 返回对象上，CLI 入口将其透传给 TUI。

可见性层面，TUI 状态栏仅在 `agentsRunning > 0` 时追加品红色的 `SUB-AGENTS n/m RUNNING` 分段，避免常驻噪音；`SubAgentManager.statusLine()` 产出相同格式，被 `spawn_agent` 的返回文本复用，让模型每次孵化后都能即时感知剩余容量。收尾顺序则是两级嵌套：harness 级 `shutdown()` 先关 MCP 再调 `subAgents.shutdown()`，后者对所有 running 状态的 worker 发出中止，然后等待全部 `finished` promise 结算且吞掉异常（`.catch(() => {})`）——保证即使某个 worker 以 error 态崩溃，进程退出路径也不会被悬空 promise 卡住。TUI 的 `teardown()` 遵循同样的先后次序。

```mermaid
sequenceDiagram
    participant R as 根代理
    participant M as SubAgentManager
    participant W as WorkerAgent
    R->>M: spawn_agent("scout", task)
    M->>M: 校验名称/唯一性/并发帽
    M->>W: new WorkerAgent(read-only tools)
    M-->>R: running 快照 + 状态行
    W->>W: prompt(task) 驱动独立循环
    R->>M: wait_agent()
    M->>W: await finished promise
    W-->>M: 终态 + finalAssistantText
    M-->>R: WorkerReport[] 分节聚合
```

Sources: [bootstrap.ts](src/bootstrap.ts#L115-L144), [bootstrap.ts](src/bootstrap.ts#L196-L204), [manager.ts](src/agents/manager.ts#L105-L114), [status-bar.ts](src/tui/status-bar.ts#L16-L38), [app.ts](src/tui/app.ts#L216-L238)

## 行为契约的测试锚点

`tests/subagents.test.ts` 用七个用例覆盖了上述全部关键语义，且全部基于 Mock 模型离线运行：

| 测试场景 | 锁定的契约 |
|----------|-----------|
| spawn → wait → 断言报告含目标内容 | 报告回收主路径与结构化输出 |
| 注入真实 read 工具让 worker 读文件 | 只读工具确实在 worker 自身上下文中执行 |
| 重名二次 spawn 抛错 | 名称唯一性校验 |
| 容量 1 时二次 spawn 抛错，wait 后可再孵化 | 并发帽拒绝语义 + 已结算释放槽位 |
| 长任务中途 close | 协作式中止及竞态宽容断言 |
| statusLine 三阶段数值变化 | 运行计数随生命周期正确增减 |
| 双 worker 无参 wait | 批量等待与报告一一对应 |

其中第二个用例尤其重要：它没有停留在"白名单里有哪些工具"的静态断言上，而是让脚本化 Mock 模型真实发起一次 `read` 工具调用，证明 worker 的独立注册表和权限管理器能走通完整的"模型→工具→结果→再推理"循环。这与仓库整体的离线 E2E 测试哲学一脉相承。

Sources: [subagents.test.ts](tests/subagents.test.ts#L32-L127)

## 小结与延伸阅读

TinyCode 的子代理监督是一个"小而完备"的参考实现：用对象图隔离替代沙箱、用拒绝式并发控制替代队列、用固定 Schema 加尾序文本提取实现报告回收，并且每一项安全属性（只读、无递归、有限并发、可中止、可观测）都能指出具体的结构性成因。理解这套机制的最佳后续路径是：先看[统一工具注册表：内置、MCP 与子代理工具的命名空间合并](11-tong-gong-ju-zhu-ce-biao-nei-zhi-mcp-yu-zi-dai-li-gong-ju-de-ming-ming-kong-jian-he-bing)了解监督工具在注册表中的合并位置，再到[TinyCodeRuntime 解剖：五个策略钩子接入 Pi 代理循环](8-tinycoderuntime-jie-pou-wu-ge-ce-lue-gou-zi-jie-ru-pi-dai-li-xun-huan)理解 worker 复用的运行时骨架，最后通过[全离线测试策略：脚本化 Mock 模型驱动真实代理循环的 E2E](26-quan-chi-xian-ce-shi-ce-lue-jiao-ben-hua-mock-mo-xing-qu-dong-zhen-shi-dai-li-xun-huan-de-e2e)掌握本文所引测试的底层驱动技术。