本页解剖 `src/agent/runtime.ts`——一个仅 103 行的装配类。它的全部价值在于：把 TinyCode 的五项 harness 策略（模型传输、权限闸门、结果截断、自动压缩、会话落盘）通过 Pi `Agent` 暴露的五个扩展点注入代理循环，而完全不触碰循环本身的控制流。我们将逐一验证每个钩子的接线方式、调用时机与返回契约。

## 为什么只需要一百行：策略与控制流的分离

理解这个文件的前提是一个架构决策：**代理循环的控制流完全归 Pi 所有，TinyCode 只贡献策略**。"何时停止"、"如何解析工具调用"、"如何执行工具"这些逻辑都在 `@earendil-works/pi-agent-core` 的 `agentLoop` 内部实现；TinyCode 对此零侵入、零重写。`ARCHITECTURE.md` 明确陈述了这一边界："What TinyCode adds to the loop is policy, not control flow"。这正是 `TinyCodeRuntime` 能保持百行规模的根因——它不做编排，只做注入。

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L32-L61)

Pi 侧的可扩展面由 `AgentOptions` 接口定义，包含 `convertToLlm`、`transformContext`、`beforeToolCall`、`afterToolCall`、`shouldStopAfterTurn`、`prepareNextTurn` 等十余个可选字段。TinyCode 从中挑选了三个函数钩子加一个事件订阅，再配合必填的 `streamFn`，构成五个集成点。未被选用的钩子（如 `shouldStopAfterTurn`）保持默认行为，意味着终止判定、转向排队等机制完全沿用 Pi 语义。

Sources: [agent.d.ts](node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts#L5-L25)

## 构造函数接线：RuntimeOptions 到 AgentOptions 的映射

`RuntimeOptions` 接口声明了装配所需的九个依赖：项目根、系统提示词、模型对象、流式函数、工具注册表、权限管理器、上下文管理器、摘要器和可选的会话管理器。注意这里传入的都是**已构建好的策略对象**而非原始配置——`TinyCodeRuntime` 不负责解析配置或创建子系统，那是 `bootstrapHarness` 的职责（见 [Harness 装配流程](7-harness-zhuang-pei-liu-cheng-bootstrap-ru-he-chuan-lian-quan-bu-zi-xi-tong)）。

Sources: [runtime.ts](src/agent/runtime.ts#L16-L26)

构造函数内的一次性 `new Agent({...})` 调用完成了全部接线。除了五个钩子，`initialState` 还注入了 `systemPrompt`、`model`、`tools` 三项初始状态，以及一个值得注意的细节：`thinkingLevel: "minimal"` 而非 `"off"`。源码注释解释了原因——若干托管端点（如 OpenRouter 上的 claude-haiku-4.5）会直接拒绝显式禁用推理的请求，而不支持思考模式的模型则会忽略该提示。这是一个典型的兼容性防御：选择"最小推理"作为所有提供商都能接受的安全值。

Sources: [runtime.ts](src/agent/runtime.ts#L31-L42)

五个钩子与策略对象的对应关系如下表所示：

| # | Pi 钩子 | 安装的策略 | 实际委托给 | 返回契约 |
|---|--------|-----------|-----------|---------|
| 1 | `streamFn` | 授权解析后的流式传输 + 输出上限 | `ModelRegistry.streamFn` → `models.streamSimple` | 流式响应（无拦截语义） |
| 2 | `beforeToolCall` | 每次工具调用前的权限闸门 | `PermissionManager.check` | `undefined`=放行；`{block:true, reason}`=阻断 |
| 3 | `afterToolCall` | 工具结果上下文卫生 | `ContextManager.handleAfterToolCall` | `undefined`=原样保留；部分覆盖对象 |
| 4 | `transformContext` | 超预算时自动压缩 | `ContextManager.makeTransformContext(summarize)` | `Promise<AgentMessage[]>` |
| 5 | `subscribe` | 定稿消息持久化 | `SessionManager.record` | `void` |

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L38-L47)、[runtime.ts](src/agent/runtime.ts#L43-L55)

一个诚实的观察：`runtime.ts` 的头注释只列了四条策略（权限、截断、压缩、落盘），因为 `streamFn` 在 TinyCode 视角属于"传输层"而非"策略层"；但 `ARCHITECTURE.md` 的集成点表格把它计入第五行。本页采用后者的口径——对代理循环而言，每一次模型请求都必须经过这个函数，它与四个策略钩子在接入地位上完全等价。

Sources: [runtime.ts](src/agent/runtime.ts#L8-L15)、[ARCHITECTURE.md](ARCHITECTURE.md#L41-L47)

整体依赖方向如下图所示——策略组件单向流入装配器，装配器再把钩子交给 Pi 循环：

```mermaid
flowchart TB
    subgraph TC["TinyCode 自研层（策略）"]
        MR["ModelRegistry.streamFn<br/>maxTokens 封顶"]
        PM["PermissionManager<br/>allow / deny 裁决"]
        CM["ContextManager<br/>截断 + 自动压缩"]
        SM["SessionManager<br/>JSONL 落盘"]
    end
    subgraph RT["TinyCodeRuntime · 约 103 行"]
        W["new Agent&#123; 五个钩子 &#125;"]
    end
    subgraph PI["Pi Agent Core（控制流）"]
        AG["agentLoop<br/>流式请求 · 工具调度 · 终止判定"]
    end
    MR -->|"streamFn"| W
    PM -->|"beforeToolCall"| W
    CM -->|"afterToolCall / transformContext"| W
    SM -.->|"subscribe"| W
    W --> AG
```

Sources: [runtime.ts](src/agent/runtime.ts#L28-L65)、[ARCHITECTURE.md](ARCHITECTURE.md#L6-L30)

## 钩子一 streamFn：带输出上限的模型传输代理

`streamFn` 是唯一没有"拦截"语义的钩子——它就是循环获取模型响应的通道。TinyCode 交付的不是裸函数，而是 `ModelRegistry` 上的一个包装器：先从请求选项或模型对象中取出期望的 `maxTokens`，若注册表设置了 `outputCap` 则通过 `Math.min` 取更小值，最后转发给底层 `models.streamSimple`。这样每一轮请求都自动带上输出上限，无需修改任何调用方代码。

Sources: [registry.ts](src/model/registry.ts#L116-L124)

封顶值的来源在 bootstrap 中：默认 `16384` tokens，注释说明这是为了绕开全额 32k+ 限制会触发的预付额度预检失败（OpenRouter 402）。这个设计让"输出上限"成为模型注册表的横切关注点，而不是散落在各处的魔法数字。

Sources: [bootstrap.ts](src/bootstrap.ts#L69-L72)

从调用时机看，`streamFn` 在循环内部每次需要生成助手回复时被调用，位于 `transformContext` 改写之后、`convertToLlm` 消息转换之后——也就是说它收到的是已经过压缩和格式转换的最终 LLM 上下文。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L178-L195)

## 钩子二 beforeToolCall：拿到的是已校验参数

权限闸门的实现只有九行：调用 `permissions.check(toolCall.name, args)`，若裁决为 `deny` 则返回 `{ block: true, reason }`，否则返回 `undefined` 放行。关键在于 Pi 侧的调用时机——`beforeToolCall` 在 `prepareToolCallArguments` 和 `validateToolArguments` **之后**触发，因此钩子收到的 `args` 已经通过了工具的 TypeBox 模式校验。权限分类器因此可以放心地对 `bash` 的 `command` 字符串做分段风险判定，不必处理畸形参数。

Sources: [runtime.ts](src/agent/runtime.ts#L44-L53)、[agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L402-L411)

`BeforeToolCallResult` 契约支持三个字段：`block`（是否阻断）、`reason`（展示给模型的理由）、`terminate`（是否在整批工具结束后提前终止）。当 `block` 为真时，Pi 会用 `createErrorToolResult(reason)` 构造一个错误类型的工具结果直接替代执行——这意味着**被拒绝的工具调用不会消失，而是以模型可读的错误文本回到对话中**，模型能据此调整策略而不是盲目重试。

Sources: [types.d.ts](node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L40-L48)、[agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L419-L428)

`PermissionManager.check` 返回统一的 `Decision` 类型（仅 `allow`/`deny` 两态），内部的 ASK 回退、记忆模式、auto 模式等裁决顺序都被封装在管理器之内，运行时钩子完全不感知。这种单向依赖让运行时代码保持极简，也意味着裁决逻辑的演进不需要触碰 `runtime.ts`。裁决顺序本身在 [权限闸门裁决顺序](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui) 中详述。

Sources: [manager.ts](src/permissions/manager.ts#L82-L122)、[types.d.ts](node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L75-L84)

另一个容易忽略的细节：钩子返回后、工具执行前，循环还会再检查一次中止信号——用户按 Ctrl+C 可以精确打断"已批准但未执行"的工具调用。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L412-L418)

## 钩子三 afterToolCall：undefined 即"原样放行"

`afterToolCall` 直接委托给 `ContextManager.handleAfterToolCall`。后者遍历结果中的每个文本分片，用 `truncateMiddle` 执行中段截断（保留头尾）；若配置了 `artifactsDir`，则先把完整输出写入工件文件，并在截断文本末尾追加 `[full output saved to …]` 提示。工件保存包在 try/catch 里且注释明言"best-effort"——磁盘写入失败只会降级为纯截断，绝不影响工具结果的交付。

Sources: [context/manager.ts](src/context/manager.ts#L39-L70)

这个钩子的返回契约有一个精妙的设计：**返回 `undefined` 表示"我没有任何修改"**，Pi 将保留原始执行结果；只有当确实发生了字符丢弃时，才返回 `{ content, details, isError }` 部分覆盖对象。Pi 的合并语义是逐字段的——提供的字段整体替换，省略的字段保留原值。`handleAfterToolCall` 利用了这一点：未截断时返回 `undefined`（零拷贝快路径），有截断时也只需提供 `content`，`details` 与 `isError` 原样透传。

Sources: [types.d.ts](node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L49-L73)、[context/manager.ts](src/context/manager.ts#L64-L69)

截断阈值、工件目录等参数由 bootstrap 从配置装配（默认单条结果 30,000 字符，工件存于 `<dataHome>/sessions/artifacts/`）。截断策略的完整行为分析（头尾保留比例、标记格式）见 [工具结果截断策略](17-gong-ju-jie-guo-jie-duan-ce-lue-tou-wei-bao-liu-yu-wan-zheng-shu-chu-gui-dang-wei-gong-jian)。

Sources: [bootstrap.ts](src/bootstrap.ts#L89-L98)

## 钩子四 transformContext：每次请求前都会跑的守门员

`transformContext` 的接线同样是一行委托：`options.contextManager.makeTransformContext(options.summarize)`。工厂方法返回的闭包逻辑极简——先问 `shouldAutoCompact`（token 估算超过 `compactAboveTokens` 且未禁用），不超预算就原样返回消息数组，超了才执行 `compact`：把较旧的消息交给摘要器生成一段密集交接笔记，与受保护的最近消息拼接为新转写。

Sources: [runtime.ts](src/agent/runtime.ts#L43)、[context/manager.ts](src/context/manager.ts#L76-L104)

调用时机是这个钩子最容易被误解的地方：它位于 `streamAssistantResponse` 函数开头，即**循环的每一轮向模型发起新请求之前都会执行**，而不是只在会话开始时跑一次。这保证了长会话中反复膨胀的上下文会在每轮请求前被重新评估——第 N 轮超预算，第 N 轮的请求就已经使用压缩后的历史。摘要器的提示词要求产出"目标、已尝试方案、改动文件路径、当前状态、测试结果、下一步"的交接笔记，定义在 bootstrap 的 `COMPACTION_SYSTEM_PROMPT` 常量中。

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L179-L185)、[bootstrap.ts](src/bootstrap.ts#L31-L34)

与自动压缩互补的是一个手动入口：`compactNow()` 方法服务于 `/compact` 斜杠命令。它复制当前消息数组、估算压缩前后 token 数、调用同一个 `compact` 例程，然后用 `splice` 把压缩结果原地写回 `agent.state.messages`。之所以用 splice 而不是赋值，是因为 Pi 的 state setter 会对顶层数组做防御性拷贝，原地修改才能保住外部持有的引用一致性。若没有可压缩的内容（最近对话全在保护窗口内），方法返回明确的提示字符串而非报错。

Sources: [runtime.ts](src/agent/runtime.ts#L85-L97)

压缩算法的分界点选取（用户消息边界切分、保护最近 N 条）与预算计算细节属于 [Token 预算与自动压缩](18-token-yu-suan-yu-zi-dong-ya-suo-hui-hua-zhai-yao-sheng-cheng-yu-bao-hu-chuang-kou) 的范畴。

Sources: [context/manager.ts](src/context/manager.ts#L81-L94)

## 钩子五 subscribe：与 UI 解耦的持久化通道

第五个接入点不走构造函数选项，而是实例方法 `agent.subscribe`。TinyCode 的订阅器只关心一种事件：`message_end`——每当一条消息（用户、助手或工具结果）定稿进入转写，就调用 `session.record(event.message)` 写入 JSONL 文件。这个过滤条件确保只有不可变的历史记录被持久化，流式中间态（`message_update`）不会产生脏数据。

Sources: [runtime.ts](src/agent/runtime.ts#L57-L64)、[types.d.ts](node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L374-L412)

订阅机制的语义值得细读：多个监听器按订阅顺序依次 await，并且都被纳入当前运行的结算集合——`agent_end` 是一次运行的最后一个事件，但代理要等到该事件的全部监听器完成后才转为空闲。这意味着**会话落盘完成之前，下一次 `prompt()` 不会被调度**，崩溃安全由此获得顺序保证。TUI 正是利用多订阅者能力注册了自己的监听器来驱动界面渲染（`app.ts` 中的独立 `subscribe` 调用），持久化与渲染互不干扰、互不感知。

Sources: [agent.d.ts](node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts#L60-L70)、[app.ts](src/tui/app.ts#L118-L118)

值得注意的是订阅器的条件装配：`session` 在 `RuntimeOptions` 中是可选项，一次性 `-p` 模式可以不带会话运行，此时整个订阅分支被跳过。JSONL 存储格式与崩溃安全设计的深入分析见 [追加式 JSONL 存储](19-zhui-jia-shi-jsonl-cun-chu-beng-kui-an-quan-de-hui-hua-chi-jiu-hua-she-ji)。

Sources: [runtime.ts](src/agent/runtime.ts#L25-L26)、[bootstrap.ts](src/bootstrap.ts#L104-L113)

## 全景时序：一次工具调用如何穿越五个钩子

把五个钩子放回同一张时序图中，可以看清它们在循环中的相对位置——两个在请求前，两个在工具前后成对出现，一个在事件侧异步消费：

```mermaid
sequenceDiagram
    participant U as 用户
    participant R as TinyCodeRuntime
    participant A as Pi 代理循环
    participant M as streamFn
    participant P as 权限闸门
    participant T as Tool.execute
    participant C as ContextManager
    participant S as SessionManager

    U->>R: prompt(text)
    R->>A: agent.prompt()
    loop 每一轮助手回复
        A->>C: transformContext(messages)
        Note over C: 超 compactAboveTokens 才压缩
        A->>M: streamFn(model, llmContext)
        M-->>A: 流式助手消息
        alt 含工具调用
            A->>A: TypeBox 参数校验
            A->>P: beforeToolCall(name, validatedArgs)
            alt deny
                P-->>A: block=true → 错误工具结果回给模型
            else allow
                A->>T: execute(id, args, signal)
                T-->>A: {content, details}
                A->>C: afterToolCall(result)
                Note over C: 中段截断 + 工件归档
            end
        end
        A-->>S: message_end → record(message)
    end
```

Sources: [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L178-L195)、[runtime.ts](src/agent/runtime.ts#L44-L64)

这张图也印证了 ARCHITECTURE.md 的核心论断：循环的骨架（流式 → 校验 → 执行 → 追加 → 重复）完全由 Pi 驱动，TinyCode 的钩子只是在骨架的关键节点上做裁决与整形。工具调用从流式响应到结果落盘的完整流水线将在下一页展开。

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L52-L61)

## 公共 API 面：六个成员背后的薄封装

`TinyCodeRuntime` 除构造外只暴露六个成员，全部是对 `this.agent` 的直接透传或轻量操作：

| 成员 | 签名 | 职责 |
|------|------|------|
| `prompt` | `(text: string) => Promise<void>` | 发送一条用户消息并阻塞至循环跑完 |
| `abort` | `() => void` | 通过 `AbortController` 中止当前运行 |
| `setModel` | `(model) => void` | `/model` 与 `--model` 的热切换，直接写 `agent.state.model` |
| `busy` | getter | 透传 `agent.state.isStreaming` |
| `compactNow` | `() => Promise<string>` | 手动压缩，返回含前后 token 估算的状态行 |
| `waitForIdle` | `() => Promise<void>` | 等待运行及全部事件监听器结算完毕 |

Sources: [runtime.ts](src/agent/runtime.ts#L67-L102)

其中 `setModel` 的热切换值得一提：它只改写 state 上的模型字段，不重建 Agent、不清空转写，因此正在进行的对话可以在下一轮请求无缝切换到新模型。而会话生命周期中的 `/new` 命令调用 `Agent.reset()` 清空转写时，Pi 保证系统提示词、模型、工具列表与**已安装的钩子全部保留**——五个策略接入点是构造期一次性注入的，任何状态轮换都不会导致策略失效。

Sources: [runtime.ts](src/agent/runtime.ts#L76-L79)、[ARCHITECTURE.md](ARCHITECTURE.md#L156-L162)

## 小结与延伸阅读

`TinyCodeRuntime` 是整个仓库"薄壳厚策略"哲学的最佳标本：103 行代码、一个构造函数、五个钩子，就把权限、上下文卫生、压缩与持久化四套子系统挂到了第三方代理循环上。它的可读性来自两个纪律——所有钩子都是一行委托（复杂度下沉到策略对象内部），以及严格区分"策略"与"控制流"的职责边界。

建议按以下路径继续深入：

- 理解钩子触发所在的完整循环骨架 → [代理循环与工具执行流水线：从流式响应到结果落盘](9-dai-li-xun-huan-yu-gong-ju-zhi-xing-liu-shui-xian-cong-liu-shi-xiang-ying-dao-jie-guo-luo-pan)
- `beforeToolCall` 背后的裁决顺序与 ASK 回退 → [权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)
- `afterToolCall` 与 `transformContext` 的策略细节 → [Token 预算与自动压缩：会话摘要生成与保护窗口](18-token-yu-suan-yu-zi-dong-ya-suo-hui-hua-zhai-yao-sheng-cheng-yu-bao-hu-chuang-kou)
- `subscribe` 写入的存储格式 → [追加式 JSONL 存储：崩溃安全的会话持久化设计](19-zhui-jia-shi-jsonl-cun-chu-beng-kui-an-quan-de-hui-hua-chi-jiu-hua-she-ji)
- `streamFn` 的上游选择链 → [模型注册表：多提供商选择链与 Mock 模型注入](25-mo-xing-zhu-ce-biao-duo-ti-gong-shang-xuan-ze-lian-yu-mock-mo-xing-zhu-ru)