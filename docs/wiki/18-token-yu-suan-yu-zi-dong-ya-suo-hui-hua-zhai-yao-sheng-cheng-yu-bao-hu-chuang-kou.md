长会话是编码智能体的常态：工具调用不断累积，上下文窗口终将耗尽。TinyCode 的应对方案是一套两层上下文工程——第一层对每个工具结果做即时截断（详见[工具结果截断策略：头尾保留与完整输出归档为工件](17-gong-ju-jie-guo-jie-duan-ce-lue-tou-wei-bao-liu-yu-wan-zheng-shu-chu-gui-dang-wei-gong-jian)），第二层则在整体上下文超出预算时，把最古老的对话轮次替换为一条由 LLM 生成的摘要消息。本页聚焦第二层：token 如何被估算、压缩何时触发、"保护窗口"如何保证近期工作不被摘要吞掉，以及摘要本身是如何生成的。

## 压缩流水线的全景

自动压缩不是单一函数，而是分布在三个模块中的一条流水线：`ContextManager` 持有决策逻辑，`compact.ts` 提供纯函数式的切分与渲染原语，`bootstrap.ts` 负责把真实的 LLM 调用注入为摘要器。整条链路在每次模型请求之前由 Pi 运行时的 `transformContext` 钩子驱动：

```mermaid
flowchart LR
    A[transformContext 钩子<br/>每次请求前触发] --> B{shouldAutoCompact:<br/>estimateTokens > compactAboveTokens?}
    B -- 否 --> C[原样返回消息数组]
    B -- 是 --> D[splitForCompact<br/>从后向前找用户消息边界]
    D -- 无可切分点 --> C
    D -- 找到切点 --> E[buildTranscriptText<br/>渲染旧轮次为扁平文本]
    E --> F[Summarizer<br/>单次 completeSimple LLM 调用]
    F --> G[compactSummaryMessage<br/>包装为 conversation-summary 用户消息]
    G --> H[新上下文 = 摘要消息 + recent 原文]
```

这条流水线的关键设计在于"失败即透传"：阈值未到就原样返回，找不到安全切分点也原样返回，甚至摘要调用失败也不会中断代理循环——只会以占位文本进入上下文。这种保守语义保证了压缩永远不会成为会话的单点故障。

Sources: [manager.ts](src/context/manager.ts#L15-L22), [manager.ts](src/context/manager.ts#L96-L104), [compact.ts](src/context/compact.ts#L24-L38)

## Token 预算：确定性估算与三级默认值

判断"上下文是否过大"需要一个 token 计数器，但 TinyCode 刻意不依赖任何 provider 的 tokenizer API。`estimateTokens` 把每条消息做 `JSON.stringify` 后按字符数累加，再除以 4 向上取整——注释直言这是粗略估计（约 4 字符 ≈ 1 token），但它离线可用、完全确定性，且在 provider 返回真实 usage 时可以做得更准（只是当前实现选择了不依赖它）：

```typescript
export function estimateTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += JSON.stringify(message).length;
  }
  return Math.ceil(chars / 4);
}
```

预算阈值 `compactAboveTokens` 支持配置覆盖，默认值的计算发生在 bootstrap 装配阶段：优先取模型上下文窗口的 80%（向下取整），模型未暴露窗口大小时回退到固定 100k。这意味着换一个更大窗口的模型，压缩会自动推迟触发——预算跟随模型能力缩放，而非写死常量。

| 配置项 | Schema 约束 | 默认值 | 作用 |
|---|---|---|---|
| `context.compactAboveTokens` | 正整数 | `floor(contextWindow × 0.8)` 或 `100_000` | 估算 token 超过此值时触发自动压缩；设为 `0` 彻底关闭 |
| `context.keepRecentMessages` | 最小为 2 | `12` | 压缩时永远逐字保留的最近消息数量 |
| `context.maxToolResultChars` | 正整数 | `30_000` | 单条工具结果在转录中的字符上限（第一层防御） |

Sources: [compact.ts](src/context/compact.ts#L85-L91), [schema.ts](src/config/schema.ts#L23-L32), [bootstrap.ts](src/bootstrap.ts#L89-L98)

## 保护窗口：用户消息边界上的向后扫描

自动压缩最大的风险是把"正在进行的工作"压没了——最新的错误信息、刚编辑过的文件路径、当前任务的目标，一旦进入摘要就可能失真。`splitForCompact` 用两个正交机制防范这一点。

第一个机制是**数量保护**：`maxCut = messages.length - keepRecent` 先划出禁区，索引大于等于 `maxCut` 的消息永远留在 `recent` 数组中逐字保留。第二个机制是**边界保护**：切点必须落在 `role === "user"` 的消息上。扫描方向是从 `maxCut` 向前递减，找到的第一个用户消息即为切点。这保证了一条 assistant 消息永远不会与其对应的 toolResult 分离——它们要么一起进摘要，要么一起留在原文里。

```mermaid
flowchart TB
    subgraph messages["完整转录"]
        direction LR
        M0["msg[0]<br/>user"] --- M1["msg[1]"] --- M2["..."] --- M3["cutIndex<br/>user ✓"] --- M4["msg[+1]"] --- M5["...<br/>禁区 ≥ maxCut"]
    end
    M0 -.进入 old.-> OLD["old: 送入摘要器"]
    M3 --连同其后全部--> REC["recent: 逐字保留"]
    M3@{ shape: framed-circle }
    style M3 fill:#2d5a27,color:#fff
```

当扫描结果 `cutIndex <= 0`（包括找不到任何用户边界、或唯一边界就是第 0 条消息）时，函数返回空的 `old` 数组——此时没有可安全压缩的内容。这个"宁可不动手"的分支被测试明确覆盖：一个只有 assistant 和 toolResult 开头的短对话，即使超过预算也会被拒绝切分。

Sources: [compact.ts](src/context/compact.ts#L9-L38), [tests/context.test.ts](tests/context.test.ts#L109-L137)

## 会话摘要生成：一次带专用系统提示词的 LLM 调用

切出的 `old` 数组不能直接喂给模型——需要先展平成文本。`buildTranscriptText` 为每种角色定义了渲染模板，并施加两级字符钳制：单条消息正文最多保留 4000 字符（超出则截断加 `[…clipped…]` 标记），assistant 消息中的工具调用参数最多序列化前 300 字符，thinking 块直接丢弃。这防止了摘要器的输入本身失控膨胀。

| 角色 | 渲染格式 | 特殊处理 |
|---|---|---|
| `user` | `[USER]\n<content>` | 图片部分替换为 `[image]` 占位 |
| `assistant` | `[ASSISTANT]\n<text>` | thinking 块置空；工具调用呈现为 `[tool call: name(args 前 300 字符)]` |
| `toolResult` | `[TOOL RESULT for name]` | 出错时附加 `(error)` 标记 |
| 其他角色 | `[ROLE] <JSON.stringify>` | 兜底分支，同样受 4000 字符钳制 |

真正的摘要调用在 `makeDefaultSummarizer` 中完成：一次 `models.completeSimple` 请求，系统提示词要求产出"密集交接笔记"——用户目标、已尝试的手段、修改过的文件（含路径）、当前状态、测试/构建结果、确切的下一步，并要求代码标识符逐字保留。这里没有任何重试或回退逻辑：调用失败时返回 `(summary failed: <message>)` 字符串，让异常以可见但非致命的方式流入上下文，代理循环继续运转。

Sources: [compact.ts](src/context/compact.ts#L18-L69), [bootstrap.ts](src/bootstrap.ts#L31-L34), [bootstrap.ts](src/bootstrap.ts#L220-L242)

## 摘要的注入形态与运行时接线

摘要文本不会以系统提示词的身份回归，而是被 `compactSummaryMessage` 包装成一条 **user 角色消息**，外层套 `<conversation-summary>` XML 标签，尾随一句 "Earlier conversation was summarized above. Continue from the current state."。选择 user 角色而非 system 有双重意义：其一，多数 provider 对 system 消息有唯一性或位置约束，动态插队容易踩坑；其二，user 消息天然满足后续切分所需的边界条件——摘要消息本身就是下一次压缩的合法切点。

接线发生在 `TinyCodeRuntime` 构造函数中：`transformContext` 钩子由 `contextManager.makeTransformContext(summarize)` 工厂生成，闭包捕获了摘要器。该钩子在 Pi 代理循环的每次请求前执行，形成"检查 → 压缩 → 再发请求"的隐式前置步骤。由于 `compact` 是异步的且接受 `AbortSignal`，用户中断操作也能传播到正在进行的摘要调用。

```mermaid
sequenceDiagram
    participant Loop as Pi 代理循环
    participant TC as transformContext
    participant CM as ContextManager
    participant S as Summarizer (bootstrap)
    participant API as 模型端点
    Loop->>TC: 发送请求前传入全部消息
    TC->>CM: shouldAutoCompact(messages)?
    alt 未超预算
        CM-->>Loop: 原样返回
    else 超预算且有安全切点
        CM->>S: buildTranscriptText(old)
        S->>API: completeSimple(压缩专用系统提示词 + 转录文本)
        API-->>S: 摘要文本（失败则返回占位串）
        S-->>CM: summaryText
        CM-->>Loop: [<conversation-summary> 消息, ...recent 原文]
    end
```

Sources: [compact.ts](src/context/compact.ts#L71-L79), [runtime.ts](src/agent/runtime.ts#L43), [manager.ts](src/context/manager.ts#L81-L104)

## 自动压缩之外：手动 `/compact` 与用量可视化

除了请求前的自动触发，`TinyCodeRuntime.compactNow` 暴露了一个手动入口，由 TUI 斜杠命令 `/compact` 调用。它与自动路径共享同一个 `compact` 方法和保护窗口逻辑，差异在于反馈方式：完成后返回一行状态报告，形如 `Compacted: 42 → 13 messages (~88000 → ~21000 tokens est.)`；若无可压缩内容则提示 "Nothing compactable (recent conversation is protected)"。手动压缩直接原地改写 `agent.state.messages`，后续轮次立即受益于瘦身后的上下文。

用量的可观测性由底部状态栏承担：它展示 `ctx ~XX.Xk / ~YY.Yk` 格式的估算值与上限（若模型声明了 contextWindow）。这让开发者能在压缩触发前直观看到预算消耗曲线，而非被动等待摘要出现。关于斜杠命令的完整清单，参见[交互式 TUI 使用指南：快捷键、输入与斜杠命令](4-jiao-hu-shi-tui-shi-yong-zhi-nan-kuai-jie-jian-shu-ru-yu-xie-gang-ming-ling)。

| 维度 | 自动压缩 | 手动 `/compact` |
|---|---|---|
| 触发时机 | 每次 API 请求前（`transformContext`） | 用户显式输入命令 |
| 触发条件 | 估算 token > `compactAboveTokens` | 无条件尝试 |
| 结果反馈 | 无（静默替换上下文） | 返回前后消息数与 token 估算对比 |
| 失败语义 | 摘要失败仍继续（占位文本） | 同左，状态行照常返回 |

Sources: [runtime.ts](src/agent/runtime.ts#L85-L97), [slash.ts](src/tui/slash.ts#L136-L137), [status-bar.ts](src/tui/status-bar.ts#L28-L29)

## 测试锁定的行为契约

`tests/context.test.ts` 用纯单元测试覆盖了压缩的全部关键分支，无需任何网络。值得注意的断言包括：切点必须落在用户消息上且取"不超过禁区的最后一个合法边界"；全保护区时返回空 `old` 且 `recent === conversation`（引用相等，证明未拷贝）；`compacted[0]` 必须包含 `<conversation-summary>` 标记且总长度为 `1 + recent.length`；以及 `compactAboveTokens: 0` 时 `transformContext` 直接返回原数组引用——摘要器连调用机会都没有（测试用一个计数器证明了这一点）。这些测试共同固化了本页所述的每一个设计决策，使重构时有明确的回归防线。

Sources: [tests/context.test.ts](tests/context.test.ts#L146-L207)

## 延伸阅读

理解了整体上下文工程的两层防御后，建议按以下顺序深入相邻主题：

- 想了解第一层防御（单条工具结果的头尾保留与工件归档）如何与本页的全局压缩互补，请阅读[工具结果截断策略：头尾保留与完整输出归档为工件](17-gong-ju-jie-guo-jie-duan-ce-lue-tou-wei-bao-liu-yu-wan-zheng-shu-chu-gui-dang-wei-gong-jian)。
- 想弄清 `transformContext` 在五个策略钩子中的确切位置及其与 Pi 运行时的关系，请阅读[TinyCodeRuntime 解剖：五个策略钩子接入 Pi 代理循环](8-tinycoderuntime-jie-pou-wu-ge-ce-lue-gou-zi-jie-ru-pi-dai-li-xun-huan)。
- 想知道摘要调用背后的模型解析链与 `contextWindow` 从何而来，请阅读[模型注册表：多提供商选择链与 Mock 模型注入](25-mo-xing-zhu-ce-biao-duo-ti-gong-shang-xuan-ze-lian-yu-mock-mo-xing-zhu-ru)。