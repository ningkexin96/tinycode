TinyCode 的交互界面是一个构建在 `@earendil-works/pi-tui`（v0.84.3）之上的全屏终端应用，全部界面代码集中在 `src/tui/` 下约 950 行 TypeScript 中。本页从三个维度解剖它的组成方式：**组件树**如何用 flex 式布局堆叠出全屏结构；**事件映射**如何把代理循环的 `AgentEvent` 流翻译为具体的 UI 变更；以及 **显式重绘规则**——pi-tui 不做自动脏检查，渲染帧完全由代码中的 `requestRender()` 调用驱动。理解这三者后，你会明白为什么这个 TUI 在流式输出时既流畅又可预测。

## 全屏组件树：AltScreen 布局根与三层堆叠

TUI 的骨架在 `TuiApp` 构造函数中一次性装配完成。入口是 `TuiAltScreen`（备选屏幕缓冲区）包住一个 `ProcessTerminal`，随后若终端支持全屏模式，则通过 `setLayoutRoot()` 安装一棵两行的 VStack 布局树：上方是占据全部剩余空间的 `ScrollView`（配置 `follow: "end"` 自动滚动到底部、`primary: true` 接收滚轮事件），下方是 `basis: "auto"、shrink: 1、minSize: 3` 的底部堆栈——即布局系统承诺给输入区的最小三行。源码中直接用 ASCII 图注释了这一结构。

Sources: [app.ts](src/tui/app.ts#L48-L57), [app.ts](src/tui/app.ts#L74-L106)

```mermaid
graph TD
    A["TuiAltScreen<br/>(ProcessTerminal)"] -->|"setLayoutRoot"| B["VStack 布局根"]
    B -->|"basis:0 · grow:1 · minSize:1"| C["ScrollView<br/>follow:end · primary:true"]
    C --> D["TranscriptView.container<br/>(Container)"]
    D --> D1["用户消息 Text 行"]
    D --> D2["助手消息：流式 Text ⇄ Markdown"]
    D --> D3["工具条目行 + 结果行"]
    B -->|"basis:auto · shrink:1 · minSize:3"| E["bottomStack (VStack)"]
    E --> F["LoaderHost<br/>◐ thinking / running N tool call(s)"]
    E --> G["Editor 输入框<br/>焦点态亮蓝边框"]
    E --> H["StatusBar.component (Text)"]
    A -.->|"showOverlay 居中覆盖"| I["Box 权限对话框<br/>+ SelectList"]
```

底部堆栈自上而下是三个组件：`LoaderHost`（仅在工作时显示加载行）、`Editor`（带边框的文本编辑器，边框颜色随焦点状态切换为亮蓝或灰色）、以及 `StatusBar.component`。注意 Editor 还挂载了一个基于 `SLASH_COMMAND_NAMES` 生成的 `CombinedAutocompleteProvider`，使斜杠命令获得自动补全能力。

Sources: [app.ts](src/tui/app.ts#L91-L115)

## 转录视图：流式期间用 Text，完成后换 Markdown

`TranscriptView` 是转录区的内容管理者，它内部持有一个 pi-tui 的 `Container`，所有对话内容都以子组件形式追加进去。它的核心设计决策写在类文档注释里：**消息流式传输期间是普通 `Text` 组件（每次更新开销极低），完成后再替换为完整的 Markdown 渲染**。这是一个典型的两阶段渲染策略——高频增量阶段避免 Markdown 解析成本，低频终结阶段换取排版质量。

Sources: [transcript.ts](src/tui/transcript.ts#L7-L16)

替换动作发生在 `startAssistant()` 返回的句柄的 `finalize` 回调中：先在 Container 的 children 数组里定位原 Text 组件的下标，移除后在**同一位置** splice 插入新的 `Markdown` 组件，最后调用 `container.invalidate()` 标记布局失效。位置保持意味着即使工具条目穿插在消息之间，Markdown 也会出现在正确的顺序上。`update` 回调则只做一件事——对文本统一加两格缩进后调用 `setText`。

Sources: [transcript.ts](src/tui/transcript.ts#L27-L50)

| 方法 | 内容类型 | 渲染组件 | 触发的容器操作 |
| --- | --- | --- | --- |
| `addUser` | 用户消息（含 `❯ you` 头） | 多个 `Text` 行 | 纯追加 |
| `startAssistant().update` | 流式增量文本 | 单个 `Text` | `setText` 原地更新 |
| `startAssistant().finalize` | 完整回复 | `Markdown` | 移除 + 同位插入 + `invalidate` |
| `addToolEntry().complete` | 工具结果摘要 | 预创建的 `Text` | `setText` + 追加 + `invalidate` |
| `addError` / `addInfo` | 错误 / 系统信息 | `Text` 行 | 纯追加 |

工具条目的生命周期同样有防御性设计：`addToolEntry` 在开始时就预先创建好结果用的空 `Text` 组件，`complete` 回调里用 `hasResult` 布尔标志保证结果**只写一次**（幂等），成功且无详情时会附加最多 3 行结果预览。具体的单行摘要格式化逻辑（如 bash 显示 `✓ exit 0 · 1.2s`、edit 显示 `+12 -3` 加 diff 预览）由 `tool-view.ts` 中的纯函数提供，与 UI 容器完全解耦。

Sources: [transcript.ts](src/tui/transcript.ts#L52-L70), [tool-view.ts](src/tui/tool-view.ts#L6-L9), [tool-view.ts](src/tui/tool-view.ts#L37-L45)

## 事件映射：AgentEvent 到 UI 变更的完整翻译表

构造函数中的一行 `this.runtimeImport.agent.subscribe(...)` 把 TUI 接入了 Pi 代理循环的事件总线——这是 TUI 与运行时之间唯一的实时数据通道。`handleAgentEvent` 用一个 switch 把五种事件类型翻译成 UI 操作：

Sources: [app.ts](src/tui/app.ts#L117-L118), [app.cs](src/tui/app.ts#L282-L284)

| 事件类型 | 判定条件 | UI 动作 |
| --- | --- | --- |
| `message_start` | role=user 且非 `<conversation-summary>` 开头 | `transcript.addUser(text)` |
| `message_start` | role=assistant | 创建流式句柄存入 `streamHandle` |
| `message_update` | `streamHandle` 存在 | `streamHandle.update(textOfMessage(...))` |
| `message_end` | role=assistant 且句柄存在 | 有内容则 `finalize`，否则 `update("")`；清空句柄 |
| `tool_execution_start` | — | `addToolEntry(toolName, args)` 并以 `toolCallId` 为键存入 Map |
| `tool_execution_end` | 从 Map 取回条目 | `complete(details, isError, preview)` 后删除键 |
| `turn_*` / `agent_*` | — | 仅刷新状态栏 |

两个细节值得注意。其一是**配对机制**：工具调用通过 `toolCallId` 在一张 `Map<string, ToolEntryHandle>` 中把 start 与 end 事件关联起来，这使多个并行工具调用的结果能各归其位；`runPrompt` 结束时还会整体 `clear()` 这张 Map 作为兜底清理。其二是**压缩摘要过滤**：上下文自动压缩产生的 `<conversation-summary>` 合成用户消息不会被打进转录区显示。

Sources: [app.ts](src/tui/app.ts#L284-L330), [app.ts](src/tui/app.ts#L274-L275)

事件处理的末尾有一行落在 switch 之外的 `refreshStatusBar()`——**无论哪种事件都会刷新状态栏**。状态栏数据并非增量维护，而是每次都从运行时的真实状态拉取：模型标识、`contextManager.estimate()` 估算的 token 占用、子代理运行数、会话 ID 前 8 位和 busy 标志，然后整体重建一行文本。

Sources: [app.ts](src/tui/app.ts#L331-L338), [app.ts](src/tui/app.ts#L226-L238)

```mermaid
sequenceDiagram
    participant Agent as Pi 代理循环
    participant App as TuiApp.handleAgentEvent
    participant TV as TranscriptView.container
    participant SB as StatusBar

    Agent->>App: message_start(user)
    App->>TV: addUser(text)
    Agent->>App: message_start(assistant)
    App->>TV: startAssistant() → streamHandle
    loop 流式增量
        Agent->>App: message_update
        App->>TV: streamHandle.update(text)
    end
    Agent->>App: tool_execution_start
    App->>TV: addToolEntry(name,args) → 存入 toolEntries[callId]
    Agent->>App: tool_execution_end
    App->>TV: entry.complete(details,isError,preview) → 删除 Map 键
    Agent->>App: message_end(assistant)
    App->>TV: streamHandle.finalize(text) → 换 Markdown
    Note over App,SB: 每个事件末尾（switch 外）
    App->>SB: refreshStatusBar() → requestRender()
```

## 显式重绘规则：谁在什么时候调用 requestRender

pi-tui 采用**显式重绘模型**：修改组件不会自动触发屏幕更新，只有 `tui.requestRender()` 才会请求一帧重绘。TinyCode 遵循的规则可以归纳为三条。

**规则一：状态变更点显式请求渲染。** 全部调用点集中在五处——`refreshStatusBar()` 内部（所以每个代理事件天然带动一次重绘）、斜杠命令结果写入转录后、busy 时拒绝重复提交的提示后、以及每次 `handleInterrupt` 收尾处。除此之外没有任何定时器或动画循环去"猜"何时该重绘。

Sources: [app.ts](src/tui/app.ts#L237-L238), [app.ts](src/tui/app.ts#L253-L254), [app.ts](src/tui/app.ts#L259-L262), [app.ts](src/tui/app.ts#L375)

**规则二：高频动态内容用拉取式 render 覆盖。** `LoaderHost` 是唯一反例——它继承 `Text` 但覆写了 `render(width)`，在**每次被绘制时**才读取 `runtime.busy` 和 `pendingToolCalls.size` 来决定显示 `◐ thinking…` 还是 `running N tool call(s)…` 或空白。这种"渲染时求值"的模式让它无需订阅任何事件也能在每帧保持正确，代价是它只在有重绘发生时才会变化——而由于规则一保证了工作期间事件不断到来，这在实践中恰好成立。

Sources: [app.ts](src/tui/app.ts#L380-L396)

**规则三：视觉样式集中在一处且天然降级。** `theme.ts` 刻意零依赖地封装 ANSI 转义码，所有颜色辅助函数在非 TTY 输出或设置了 `NO_COLOR` 环境变量时返回恒等函数——这意味着同一套组件代码可以无损用于测试和无头渲染。状态栏还遵守一条排版约束：整行内容拼成一个字符串交给单个 `Text`，注释明确说明这是为了让过长的模型 ID 不会在中途折行。

Sources: [theme.ts](src/tui/theme.ts#L1-L11), [status-bar.ts](src/tui/status-bar.ts#L15-L19), [status-bar.ts](src/tui/status-bar.ts#L38-L44)

## 键盘输入与退出路径：双通道中断与轮询退出

全局按键通过 `tui.addInputListener` 捕获，优先级在 Editor 之前处理三个绑定：`ctrl+c` 触发共享的中断逻辑、`ctrl+d` 直接请求退出并拆除、`escape` 在忙碌时中止当前运行。`handleInterrupt` 实现了 Ctrl+C 的**双语义**：忙时是"中止任务"，空闲时则需要 2 秒内连按两次才退出（首次按给出提示）。注释解释了为什么这段逻辑必须独立成公共方法——启用 ISIG 的真实终端会把 Ctrl+C 投递为 SIGINT 信号而非字节序列，因此 `cli/index.ts` 里注册的 `process.on("SIGINT")` 回调路由到同一个方法，保证两条路径行为一致。

Sources: [app.ts](src/tui/app.ts#L341-L357), [app.ts](src/tui/app.ts#L359-L376), [cli/index.ts](src/cli/index.ts#L82-L84)

退出本身不依赖信号传播，而是靠 `run()` 里的一个 100ms 轮询：检查 `exitRequested && !busy` 后执行 `teardown()`——先等待 MCP 服务器与子代理管理器优雅关闭，再 `tui.stop()` 恢复终端并兑现 run 的 Promise。"等不忙再退"的设计确保 Ctrl+C 中止后残留的异步工作有机会落地。

Sources: [app.ts](src/tui/app.ts#L203-L215), [app.ts](src/tui/app.ts#L216-L224)

## 覆盖层与命令层：对话框与斜杠命令的接入方式

权限审批没有做成常驻组件，而是**按需弹出的模态覆盖层**。`PermissionManager` 通过 `deps.permissions.setPrompt((request) => showPermissionDialog(this.tui, request))` 拿到弹窗工厂；对话框内部组装一个 `Box`（标题、待执行操作、详情、原因加 `SelectList` 三选项），经 `tui.showOverlay(box, { anchor: "center", width })` 居中悬浮于主布局之上。整个函数返回一个 Promise，选中项或 Esc（映射为 Deny）时通过 `settled` 标志防止重复结算后隐藏覆盖层并 resolve——这正是权限闸门能以同步风格书写裁决逻辑的关键。差异化语义的深入讨论见[审批交互面：TUI 对话框与无头模式的差异化语义](15-shen-pi-jiao-hu-mian-tui-dui-hua-kuang-yu-wu-tou-mo-shi-de-chai-yi-hua-yu-yi)。

Sources: [app.ts](src/tui/app.ts#L117), [permission-dialog.ts](src/tui/permission-dialog.ts#L16-L20), [permission-dialog.ts](src/tui/permission-dialog.ts#L48-L63)

斜杠命令则刻意与 UI 解耦：`SlashContext` 接口定义命令可能触碰的一切（runtime、models、permissions、session 等 getter 和三个动作方法），由 `TuiApp` 直接实现。`executeSlashCommand` 是纯逻辑函数，返回 `string[]` 文本行而非操作 UI——命令执行完毕后由 `submit` 统一 `addInfo` 进转录区并请求重绘。注释直言这样做的动机：命令层保持纯逻辑以便无头测试。日常按键与命令速查见[交互式 TUI 使用指南：快捷键、输入与斜杠命令](4-jiao-hu-shi-tui-shi-yong-zhi-nan-kuai-jie-jian-shu-ru-yu-xie-gang-ming-ling)。

Sources: [slash.ts](src/slash.ts), [slash.ts](src/tui/slash.ts#L10-L22), [slash.ts](src/tui/slash.ts#L43-L46), [app.ts](src/tui/app.ts#L246-L257)

## 小结

TinyCode 的 TUI 证明了一个编码智能体的界面可以非常薄：一棵静态装配的全屏组件树、一条单向的 `AgentEvent → UI 变更` 映射管道、加上少量纪律性的 `requestRender()` 调用点。两阶段流式渲染（Text 换 Markdown）、以 `toolCallId` 配对的工具条目、拉取式的 LoaderHost，这三处设计共同把"流式输出的正确性"从运气变成了结构性保证。想继续深入的话：事件的上游生产者是[代理循环与工具执行流水线：从流式响应到结果落盘](9-dai-li-xun-huan-yu-gong-ju-zhi-xing-liu-shui-xian-cong-liu-shi-xiang-ying-dao-jie-guo-luo-pan)，状态栏 token 数字背后的估算来自[Token 预算与自动压缩：会话摘要生成与保护窗口](18-token-yu-suan-yu-zi-dong-ya-suo-hui-hua-zhai-yao-sheng-cheng-yu-bao-hu-chuang-kou)；这套界面如何被端到端验证，则见[质量门禁：PTY 级 TUI 测试与 Node 多版本 CI](27-zhi-liang-men-jin-pty-ji-tui-ce-shi-yu-node-duo-ban-ben-ci)。下一站推荐阅读[模型注册表：多提供商选择链与 Mock 模型注入](25-mo-xing-zhu-ce-biao-duo-ti-gong-shang-xuan-ze-lian-yu-mock-mo-xing-zhu-ru)。