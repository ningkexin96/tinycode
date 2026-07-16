上一篇 [TinyCodeRuntime 解剖](8-tinycoderuntime-jie-pou-wu-ge-ce-lue-gou-zi-jie-ru-pi-dai-li-xun-huan) 回答了"五个策略钩子接在哪里"；本页回答"钩子之间发生了什么"。我们将沿一条完整的数据旅程下行：用户 prompt 进入循环 → 模型流式吐出 partial 消息 → 工具调用块被提取并校验 → 权限闸门裁决 → 工具并发或顺序执行 → 结果被截断、归档、写入 transcript 与 JSONL 会话文件。控制流全部位于 Pi（`@earendil-works/pi-agent-core`）的 `agentLoop` 中，TinyCode 只注入策略——理解这一职责边界是读懂本页的前提。

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L52-L61)

## 全景：一次 prompt 的数据旅程

下图概括了从 `prompt()` 调用到结果落盘的完整流水线。左侧纵向链路是控制流（Pi 的双层循环），右侧三个方框是 TinyCode 在固定切面上安装的策略钩子；三处"落盘"标记对应后文的三级写入路径。

```mermaid
flowchart TD
    A["prompt(text)<br/>TinyCodeRuntime"] --> B["Agent.runWithLifecycle<br/>isStreaming = true"]
    B --> C["agentLoop 内层 while<br/>hasMoreToolCalls || 有 steering 消息"]
    C --> D["transformContext 钩子<br/>(超预算则压缩本次请求视图)"]
    D --> E["convertToLlm + streamFn<br/>流式请求提供商"]
    E --> F["partial 消息就地替换<br/>message_update 事件"]
    F --> G{"含 toolCall 块?"}
    G -- "stopReason=error/aborted" --> Z["turn_end + agent_end<br/>运行结束"]
    G -- "是" --> H["工具批次执行"]
    H --> I["beforeToolCall 钩子<br/>权限闸门 (deny→错误结果)"]
    I --> J["tool.execute(id,args,signal,onUpdate)"]
    J --> K["afterToolCall 钩子<br/>截断 + 工件落盘 ★"]
    K --> L["toolResult 消息<br/>message_start/end 事件"]
    L --> M["subscribe 钩子<br/>JSONL 追加落盘 ★"]
    M --> C
    G -- "否" --> N{"followUp 队列非空?"}
    N -- "是" --> C
    N -- "否" --> Z
```

两个星号即"从流式响应到结果落盘"标题中的终点：工件目录里的完整输出文件，以及会话 JSONL 里的一行记录。整条链路上 TinyCode 从不决定"何时停止"或"如何解析工具调用"，只在这些切面上做策略拦截。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L78-L173), [runtime.ts](src/agent/runtime.ts#L8-L15), [ARCHITECTURE.md](ARCHITECTURE.md#L38-L47)

## 循环骨架：双层 while 与事件流

`runLoop` 是整个运行时的心脏，结构上只有两层循环。**内层** `while (hasMoreToolCalls || pendingMessages.length > 0)` 处理"模型还要继续干活"的情形：每轮先注入排队的 steering 消息，再调用 `streamAssistantResponse` 取回一条助手消息；若消息含 `toolCall` 块就执行整个批次并把 `toolResult` 消息压入上下文，随后根据批次是否全员要求提前终止来更新 `hasMoreToolCalls`。**外层** `while(true)` 只在智能体本该停下时检查 follow-up 队列——若用户在运行结束后排队了新消息，就带着它们重回内层；否则发出最终的 `agent_end` 并退出。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L85-L173)

值得强调的是：TinyCode 没有安装 `shouldStopAfterTurn` 和 `prepareNextTurn`，也没有使用 `steer()`/`followUp()` API——对全仓库源码的检索证实这些扩展点保持原样未用。这意味着 TinyCode 场景下的循环退出条件非常朴素：某条助手消息不再包含工具调用，或流以 `error`/`aborted` 停止。队列机制是 Pi 提供的能力储备，而非本项目的行为路径。

Sources: [types.d.ts](node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L200-L221)

循环的每一拍都以 `AgentEvent` 的形式对外广播，这是理解后续各节的坐标系：

| 事件 | 触发时机 | 循环内语义 |
|---|---|---|
| `agent_start` / `agent_end` | 一次运行的边界 | `agent_end` 携带本次运行产生的全部新消息 |
| `turn_start` / `turn_end` | 每次模型请求前后 | `turn_end` 附带本回合的 toolResults |
| `message_start` / `message_update` / `message_end` | 消息生命周期 | `update` 承载流式增量；`end` 表示消息已定稿 |
| `tool_execution_start` / `_update` / `_end` | 单个工具调用三阶段 | `update` 来自工具的 `onUpdate` 回调 |

Sources: [types.d.ts](node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L374-L412)

## 有状态外壳：事件如何变成状态与订阅回调

低层循环是无状态的（context 由调用方传入），状态管理集中在 `Agent` 包装层。每次 `prompt()` 进入 `runWithLifecycle` 时会创建独立的 `AbortController`、置位 `isStreaming` 并登记 `activeRun`——若已有运行在进行则直接抛错。此后循环发出的每个事件都经过 `processEvents` 归约：`message_update` 刷新 `state.streamingMessage`，`message_end` 把定稿消息压入 `state.messages` 并清空 streaming 占位，`tool_execution_start/end` 维护 `pendingToolCalls` 集合。归约完成后才依**注册顺序**依次 await 各个订阅者。

Sources: [agent.js](node_modules/@earendil-works/pi-agent-core/dist/agent.js#L326-L348), [agent.js](node_modules/@earendil-works/pi-agent-core/dist/agent.js#L380-L421), [agent.d.ts](node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts#L60-L70)

这个"先归约、再通知"的顺序决定了两个工程事实。其一，TinyCodeRuntime 构造时注册的会话记录器早于 TUI 注册的渲染处理器（bootstrap 先建 runtime、TUI 后订阅），所以每条消息总是**先落盘、后上屏**。其二，异常路径也有确定的持久化语义：`handleRunFailure` 会合成一条 `stopReason` 为 `"error"` 或 `"aborted"` 的助手消息，照常走完 `message_start/message_end/turn_end/agent_end` 序列——因此即使模型请求抛出未捕获异常，这条失败消息依然会被会话记录器写进 JSONL。

Sources: [runtime.ts](src/agent/runtime.ts#L57-L64), [tui/app.ts](src/tui/app.ts#L118), [agent.js](node_modules/@earendil-works/pi-agent-core/dist/agent.js#L349-L365)

## 流式响应阶段：partial 消息的就地替换

`streamAssistantResponse` 是每个回合的起点，它完成三次转换后才发起请求：先用 TinyCode 注入的 `transformContext` 处理 AgentMessage 数组（超预算时生成摘要替换旧轮次——注意这只改变**本次请求的视图**，不改动活跃 transcript），再经 `convertToLlm` 转成提供商兼容格式，最后交给 `streamFn`。TinyCode 的 `streamFn` 就是 ModelRegistry 上那个包了一层 maxTokens 上限逻辑的 `models.streamSimple`，Mock 模式下则由脚本化的 faux provider 充当，让整条真实循环可以离线运转。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L178-L198), [manager.ts](src/context/manager.ts#L96-L104), [registry.ts](src/model/registry.ts#L116-L124)

流式消费的核心技巧是 **partial 消息的就地替换**：收到 `start` 事件时，半成品消息立即进入 `context.messages` 尾部；此后每个 `text_delta`、`thinking_delta`、`toolcall_delta` 事件都用事件携带的最新 partial **覆盖数组末位元素**，同时对外发 `message_update`。直到 `done` 或 `error` 事件到来，才通过 `response.result()` 取回带用量统计和 `stopReason` 的终稿再次覆盖。对下游而言，`context.messages` 的末尾永远是一条"正在生长"的消息——TUI 正是据此把 `message_update` 映射为实时刷新的流式文本，在 `message_end` 时才定稿为 Markdown。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L199-L254), [tui/app.ts](src/tui/app.ts#L296-L307)

流结束后有一个关键的分流判断：`stopReason === "error"` 或 `"aborted"` 会直接触发带空 toolResults 的 `turn_end` 加 `agent_end`，本轮运行即刻终止，不做任何工具执行。其余情况（`stopReason` 为 `end_turn`、`toolUse` 等）则提取 `content` 中类型为 `toolCall` 的块进入批次执行阶段。一个容易被忽略的细节是 `length`（输出 token 截断）：此情形下流式解析器的 JSON 补救可能产出**参数看似合法实则残缺**的工具调用，因此循环会把这批调用全部判死而不执行，返回的错误信息明确要求模型携带完整参数重新发起。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L108-L125), [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L256-L282)

## 工具批次：顺序与并行两种调度模式

一个助手消息可能携带多个工具调用，批次的调度模式由两级配置决定：全局 `config.toolExecution`（Pi 默认 `"parallel"`），以及单个工具声明上的 `executionMode` 覆盖——只要批次里出现任一 sequential 工具，整个批次退化为顺序执行。两种模式的对比：

| 维度 | sequential | parallel（默认） |
|---|---|---|
| 准备阶段 | 与执行交替进行 | 对全部调用**顺序**预检（含权限闸门） |
| 实际执行 | 严格逐个 | 通过的工具并发跑 `Promise.all` |
| `tool_execution_end` 顺序 | 即源顺序 | 按**完成先后**发出 |
| toolResult 消息追加顺序 | 即源顺序 | 全部完成后按 **assistant 源顺序**统一补发 |
| abort 行为 | 当前调用完成后跳出循环 | 预检循环中检测到即中断收集 |

并行模式的"预检顺序、执行乱序、成帧还原序"三段式设计保证了两个不变量：权限判定不受并发影响（闸门总在执行前串行通过），而喂回模型的 toolResult 消息序列又与请求时的工具调用顺序严格一致——后者对多工具场景下模型的因果推理至关重要。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L287-L376), [types.d.ts](node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L14-L22)

批量终止采用保守的全票规则：只有当批次中**每一个**已定稿结果的 `terminate` 都为 `true` 时（且批次非空），循环才在此批次后提前收束。单个工具要求停止不足以打断其他并行任务。abort 信号则在预检与执行的多个间隙被检查，命中即产生 `"Operation aborted"` 错误结果。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L377-L379), [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L411-L437)

## 单次调用五段流水线：校验、闸门、执行、覆写、成帧

把镜头推进到单个工具调用，其生命周期是一条五段流水线，每一段都有明确的失败出口：

```mermaid
flowchart LR
    P["① prepare<br/>查表 + 参数规整 +<br/>TypeBox 校验"] --> G["② gate<br/>beforeToolCall<br/>权限闸门"]
    G -->|"deny"| E1["immediate 错误结果<br/>不执行"]
    P -->|"找不到工具/<br/>校验失败"| E1
    G -->|"allow"| X["③ execute<br/>tool.execute(id,args,<br/>signal,onUpdate)"]
    X -->|"throw"| E2["catch 为错误结果"]
    X -->|"成功"| F["④ finalize<br/>afterToolCall<br/>字段级覆写(截断+工件)"]
    F --> M["⑤ frame<br/>构造 role=toolResult 消息<br/>发 message_start/end"]
    E1 --> M
    E2 --> F
```

**① prepare 阶段**先按名字在 `context.tools` 中查表（未命中直接产出 immediate 错误结果，不会惊动模型之外的世界）；可选的 `prepareArguments` shim 在 schema 校验前修正原始参数；随后 `validateToolArguments` 依据工具的 TypeBox 定义做强校验，任何抛出都被捕获为错误结果。**② gate 阶段**就是 TinyCode 安装的 `beforeToolCall`：把校验后的参数送进 `PermissionManager.check`，`deny` 裁决转化为 `{ block: true, reason }`，循环随即生成文本为 `"Permission denied: ..."` 的错误工具结果——注意被拒调用**消耗一个真实的 toolResult 消息**回到对话中，模型能看到拒绝理由并自行调整策略。裁决内部的优先级细节属于权限子系统的主题，见 [权限闸门裁决顺序](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L393-L452), [runtime.ts](src/agent/runtime.ts#L44-L53)

**③ execute 阶段**调用工具自身的 `execute(toolCallId, params, signal, onUpdate)` 契约：工具按约定**抛异常表示失败**（而不是把错误编码进 content），框架负责捕获转译；`onUpdate` 回调产生的部分结果以 `tool_execution_update` 事件流出，且在 promise 结算后到达的迟到更新会被 `acceptingUpdates` 标志静默丢弃。以内置 read 工具为例——它把行号渲染、大文件窗口、二进制检测都封装在自己的 execute 里，向上只暴露统一的 `AgentToolResult{content, details}` 形状：`content` 给模型看，`details` 给 UI 用。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L453-L483), [read.ts](src/tools/read.ts#L35-L117), [types.d.ts](node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L339-L357)

**④ finalize 阶段**执行 TinyCode 的 `afterToolCall` 覆写，合并语义是严格的字段级替换（content/details/isError/usage/terminate，省略即保留原值，无深合并）。**⑤ frame 阶段**把定稿结果装配成 `role: "toolResult"` 消息——此处有一处防御性归一化：无类型的 JS 扩展工具可能返回没有 content 的结果，框架强制补空数组以免 null 渗入会话历史或提供商载荷——然后为其发出 `message_start`/`message_end` 事件对。正是这个事件对触发了下一节要讲的第三级落盘。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L484-L518), [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L534-L552), [manager.ts](src/context/manager.ts#L39-L40)

## 结果落盘：transcript、工件与会话文件的三级写入

同一次工具执行的产物会沿三条独立路径沉淀，各自有不同的介质、时机与失败策略：

| 级别 | 介质 | 写入时机 | 失败策略 |
|---|---|---|---|
| ① 内存 transcript | `context.messages` 数组 | 批次执行完毕立即 push | 无（内存操作） |
| ② 工件文件 | `<sessionsDir>/artifacts/<时间戳>-<工具名>.txt` | afterToolCall 中检测到超长文本时 | 尽力而为：保存失败仅放弃指针，截断照常生效 |
| ③ 会话 JSONL | `<sessionsDir>/<id>.jsonl` 追加一行 | 该消息的 `message_end` 事件同步触发 | 吞掉异常，持久化绝不拖垮活跃会话 |

第一级最直接：批次产出的 toolResult 消息被压入运行期上下文，成为下一次模型请求的输入的一部分——这是模型"看到"工具结果的唯一通道。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L126-L129)

第二级由 ContextManager 实现：`handleAfterToolCall` 对结果里每个 text 片段执行 `truncateMiddle`——保留头尾各一半预算（默认上限 30000 字符）、中间以显式的 `[… N characters truncated …]` 标记衔接；一旦确实丢弃了字符且有 artifactsDir 配置，就把**未截断的全文**写入以 ISO 时间戳加净化工具名命名的工件文件，并在截断文本尾部追加 `[full output saved to <path>]` 指针。这样模型拿到的是尺寸可控的摘要视图，人类用户随时能打开工件核对全貌。头尾保留策略的设计权衡详见 [工具结果截断策略](17-gong-ju-jie-guo-jie-duan-ce-lve-tou-wei-bao-liu-yu-wan-zheng-shu-chu-gui-dang-wei-gong-jian)。

Sources: [manager.ts](src/context/manager.ts#L40-L70), [tool-results.ts](src/context/tool-results.ts#L17-L36), [bootstrap.ts](src/bootstrap.ts#L92-L97)

第三级的触发点在订阅侧而非循环内部：TinyCodeRuntime 构造时注册的监听器只认一种事件——`message_end`，把 `event.message` 递给 `SessionManager.record`。这个时机选择有一个重要推论：**流式过程中的任何 partial 状态都不会触碰磁盘**，只有定稿消息（用户的 prompt、助手终稿、每条 toolResult）才会以同步 `appendFileSync` 逐行追加进 JSONL 文件；同步刷盘换来的是硬杀进程也不丢已完成的消息，而加载端对残缺末行的容忍进一步兜住了崩溃窗口。record 内部还做了双重防御——存储目录未初始化时静默跳过、写盘异常整体吞掉——因为持久化的定位是"尽力而为的可观测性"，绝不能反过来威胁活跃会话。JSONL 格式与崩溃安全的完整论述见 [追加式 JSONL 存储](19-zhui-jia-shi-jsonl-cun-chu-beng-kui-an-quan-de-hui-hua-chi-jiu-hua-she-ji)。

Sources: [runtime.ts](src/agent/runtime.ts#L57-L64), [manager.ts](src/session/manager.ts#L52-L80), [storage.ts](src/session/storage.ts#L29-L32), [storage.ts](src/session/storage.ts#L38-L63)

## 终止路径：自然收敛、异常与手动 abort

循环有三种谢幕方式，它们共享同一套事件协议但语义不同。**自然收敛**：某条助手消息不含工具调用、steering 队列也空、follow-up 队列亦空——`agent_end` 携带本次运行的全部新消息收尾，`waitForIdle` 还要等所有 `agent_end` 监听器结算完毕才 resolve，这保证了最后一条消息必然已经落盘。**流级失败**：`stopReason` 为 `error`/`aborted` 直接跳过工具阶段结束运行。**运行级异常**：`streamFn` 之外的意外抛出由 `handleRunFailure` 合成失败消息走完整事件序列。三条路径殊途同归于 `finishRun`：复位 `isStreaming`、清空 pendingToolCalls、释放 activeRun。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L162-L173), [agent.js](node_modules/@earendil-works/pi-agent-core/dist/agent.js#L349-L369), [agent.d.ts](node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts#L99-L106)

手动 abort 则展示了信号如何贯穿整条流水线：TUI 的 Esc 触发 `runtime.abort()` → `agent.abort()` 中止当前 `AbortController` → 信号在流式消费、预检间隙、工具 execute 内部多点被感知。已被信号打断的流会以 `aborted` 终稿收场；正在执行的工具收到 signal 可自行中断；即便信号在两个阶段之间的微小窗口到达，prepare 阶段的显式检查也会产出 `"Operation aborted"` 错误结果。无论从哪个点切断，已定稿的部分消息都已落盘，未定稿的则随着失败消息的合成获得完整的审计痕迹。

Sources: [tui/app.ts](src/tui/app.ts#L310-L330), [runtime.ts](src/agent/runtime.ts#L72-L74), [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L407-L437)

## 小结与下一步阅读

本页沿一条垂直剖面拆解了代理循环：Pi 的双层 while 提供控制流，五个策略钩子在固定切面注入策略，一次工具调用经历"查表校验 → 权限闸门 → 执行 → 字段覆写 → 成帧"的五段流水线，其结果沿内存 transcript、工件文件、会话 JSONL 三条路径分层落盘。掌握这条流水线后，建议按以下方向深化：

- 想知道七个工具各自的 execute 契约细节 → [七大内置工具详解：read/edit/bash 等的行为契约](10-qi-da-nei-zhi-gong-ju-xiang-jie-read-edit-bash-deng-de-xing-wei-qi-yue)
- 想深入截断算法与工件设计的权衡 → [工具结果截断策略：头尾保留与完整输出归档为工件](17-gong-ju-jie-guo-jie-duan-ce-lve-tou-wei-bao-liu-yu-wan-zheng-shu-chu-gui-dang-wei-gong-jian)
- 想理解闸门 deny 之前的完整裁决链 → [权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)
- 想弄清 JSONL 文件的格式与恢复语义 → [追加式 JSONL 存储：崩溃安全的会话持久化设计](19-zhui-jia-shi-jsonl-cun-chu-beng-kui-an-quan-de-hui-hua-chi-jiu-hua-she-ji)