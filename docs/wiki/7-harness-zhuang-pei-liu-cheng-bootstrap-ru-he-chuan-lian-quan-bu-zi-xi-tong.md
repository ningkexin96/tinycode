TinyCode 的所有能力——七大内置工具、权限闸门、上下文压缩、会话持久化、技能、MCP、子代理——都散落在各自的模块里，而 `src/bootstrap.ts` 是唯一一个把它们拼装成完整产品的地方。这个文件只有 243 行，却同时服务于交互式 TUI、无头 `-p` 模式乃至 `--list-models` 这样的轻量查询。本页拆解 `bootstrapHarness()` 的装配顺序、依赖注入逻辑，以及 CLI 层如何消费同一个 `Harness` 对象。各子系统的内部行为（如权限裁决细节、MCP 连接协议）属于后续专页，这里只关注"谁在什么时机把谁交给谁"。

Sources: [bootstrap.ts](src/bootstrap.ts#L36-L48), [ARCHITECTURE.md](ARCHITECTURE.md#L1-L27)

## 组合根的定位：策略装配，而非控制流

理解 bootstrap 的关键前提是：Pi 运行时已经提供了代理循环本身——流式响应、工具调用解析、终止判定都不由 TinyCode 实现。bootstrap 做的事情是把**策略**注入这个循环：每一次工具调用前先过权限闸门，每一次工具结果返回后做截断，每一轮请求前检查 token 预算，每一条定稿消息落盘会话文件。这些策略以钩子形式在 `TinyCodeRuntime` 构造时挂接，而 `TinyCodeRuntime` 本身也是 bootstrap 装配流水线的最后一站。

换言之，`bootstrapHarness` 是典型的**组合根**：它不包含业务逻辑，只负责按正确顺序构造对象并传递引用，使得 TUI 和无头模式可以共享完全相同的产品形态。

```mermaid
graph TD
    subgraph CLI 入口层
        A["tinycode（TUI）"] --> C
        B["tinycode -p（无头）"] --> C
        D["tinycode --list-models"] --> C
    end
    C["buildHarnessFromCli<br/>loadConfig + 参数合并"] --> E["bootstrapHarness()"]
    E --> F["ModelRegistry → model"]
    E --> G["PermissionManager"]
    E --> H["ContextManager"]
    E --> I["SessionManager?"]
    E --> J["ToolRegistry<br/>7 内置 + load_skill + 子代理 + MCP"]
    E --> K["SubAgentManager?"]
    E --> L["McpManager?"]
    F & G & H & I & J --> M["TinyCodeRuntime"]
    M --> N["Harness 对象"]
    N --> O["TuiApp"]
    N --> P["runtime.prompt()"]
```

图中带问号的组件是条件装配的：只有传入了 session 选项才会建会话管理器，只有配置了 `mcpServers` 才会启动 MCP。

Sources: [runtime.ts](src/agent/runtime.ts#L8-L15), [ARCHITECTURE.md](ARCHITECTURE.md#L29-L46)

## 输入与产出契约：BootstrapOptions 与 Harness

bootstrap 的公共接口非常窄：一个选项对象进，一个 `Harness` 对象出。这种窄接口让所有入口（CLI、测试）都能以一致的方式获得完整装配体。

**输入侧** `BootstrapOptions` 只有四个字段：

| 字段 | 类型 | 作用 |
|---|---|---|
| `projectRoot` | `string` | 工作区根目录，工具路径守卫与技能发现都以它为界 |
| `config` | `TinyCodeConfig` | 已加载的配置文件内容 |
| `modelRef?` | `ModelRef` | CLI `--model` 标志解析出的模型引用，优先于配置文件 |
| `mock?` | `boolean` | 强制启用脚本化 Mock 模型 |
| `session?` | `{mode:"new"} \| {mode:"attach"; id}` | 会话意图：新建或挂载既有会话 |

**输出侧** `Harness` 把每个子系统实例原样暴露出来：

| 字段 | 消费者 |
|---|---|
| `models` / `model` | TUI 的 `/model` 切换；无头模式的摘要生成 |
| `permissions` | TUI 权限对话框；CLI 的 `--permission-mode` 后置覆盖 |
| `contextManager` / `runtime` | 无头模式直接驱动 `runtime.prompt()` |
| `tools` | 已合并全部命名空间的统一注册表 |
| `session?` / `skills` / `mcp?` / `subAgents?` | TUI 各组件分别引用 |
| `shutdown()` | 进程退出前释放 MCP 连接与子代理线程 |

注意 `Harness` 接口上明确写着：TUI 与非交互模式**共同构建于此**——这是组合根设计的直接声明。

Sources: [bootstrap.ts](src/bootstrap.ts#L41-L64)

## 八步装配流水线：每一步依赖谁

`bootstrapHarness()` 函数体的执行顺序经过精心安排，核心原则是：**被依赖者先构造**。下面这张表给出完整的步骤清单，随后逐段展开。

| 步骤 | 构造产物 | 关键依赖 | 源码位置 |
|---|---|---|---|
| 1 | `ModelRegistry` + 解析后的 `model` | 配置、环境变量、Mock 开关 | [bootstrap.ts#L69-L81](src/bootstrap.ts#L69-L81) |
| 2 | `PermissionManager` | 配置的权限模式、projectRoot | [bootstrap.ts#L84-L87](src/bootstrap.ts#L84-L87) |
| 3 | `ContextManager` | **model.contextWindow** | [bootstrap.ts#L90-L98](src/bootstrap.ts#L90-L98) |
| 4 | `SkillRegistry` + 磁盘扫描 | projectRoot | [bootstrap.ts#L100-L102](src/bootstrap.ts#L100-L102) |
| 5 | `SessionManager`（可选） | sessionsDir、session 选项 | [bootstrap.ts#L104-L113](src/bootstrap.ts#L104-L113) |
| 6 | `ToolRegistry`：7 内置 + `load_skill` | projectRoot、skills | [bootstrap.ts#L115-L128](src/bootstrap.ts#L115-L128) |
| 7 | 子代理工具 + MCP 工具并入同一注册表 | model、streamFn、mcpServers | [bootstrap.ts#L130-L153](src/bootstrap.ts#L130-L153) |
| 8 | 系统提示词 → `TinyCodeRuntime` → 恢复转录 | 前七步全部产物 | [bootstrap.ts#L155-L184](src/bootstrap.ts#L155-L184) |

### 模型先行：一切默认值的地基

第一步创建 `ModelRegistry` 时就把输出上限设为 `config.maxOutputTokens ?? 16384`——注释解释这是为了避开预付费账户在完整 32k 上限下的余额预检失败（OpenRouter 402）。Mock 判定在此处完成：显式传入的 `options.mock` 或环境变量 `TINYCODE_MODEL=mock` 都会触发 `enableMock()`。模型引用则遵循"CLI 标志 > 配置文件"的优先级链，最终通过 `models.resolve()` 得到可用的 `Model` 实例。

这一步必须最先完成，因为第 3 步和第 7 步都要消费它的产物。

Sources: [bootstrap.ts](src/bootstrap.ts#L66-L81)

### 上下文策略反向读取模型元数据

第三步最能体现装配顺序的约束：`compactAboveTokens` 的默认值不是常量，而是 `Math.floor(model.contextWindow * 0.8)`——压缩阈值随所选模型的上下文窗口动态伸缩，仅在拿不到窗口大小时才回退到 100k。这意味着 `ContextManager` 必须在模型解析之后构造。工件归档目录也在这里确定：`sessionsDir()` 下的 `artifacts/`，而该函数尊重 `TINYCODE_HOME` 环境变量重定向，测试因此能做到零污染。

Sources: [bootstrap.ts](src/bootstrap.ts#L89-L98), [loader.ts](src/config/loader.ts#L10-L16)

### 会话在工具之前、恢复在最后

会话管理器在第 5 步就位，但此时只完成了文件的打开与头部写入（`start` 或 `attach`）。真正的**转录恢复**被刻意推迟到第 8 步运行时构造完毕之后——因为恢复的目标是 `runtime.agent.state.messages` 这个数组，运行时不存在就没有恢复目标。bootstrap 用一次整体 splice 把已加载的历史消息替换进活动转录，追加写继续指向同一文件，崩溃安全语义由此保持。

Sources: [bootstrap.ts](src/bootstrap.ts#L104-L113), [bootstrap.ts](src/bootstrap.ts#L178-L184)

## 统一工具面的四波合并次序

模型看到的工具列表是一个扁平命名空间，但它的组装分四波进行，次序决定了命名冲突的裁决方向：

```mermaid
flowchart LR
    W1["第一波<br/>7 个内置工具"] --> R["ToolRegistry"]
    W2["第二波<br/>load_skill"] --> R
    W3["第三波<br/>spawn_agent / list_agents / wait_agent"] --> R
    W4["第四波<br/>MCP 远程工具"] --> R
    R --> A["Agent initialState.tools<br/>一次性快照"]
```

第一波用工厂函数数组循环注册，每个工厂只接收 `projectRoot` 一个参数——路径守卫因此在工具创建时就绑定到了工作区。第二波的 `load_skill` 直接闭包捕获了第 4 步构造的 `SkillRegistry`，这正是渐进式披露机制的接线点：提示词只放摘要，全文按需经此工具进入上下文。

第三波值得细看：子代理工作线程的工具集是手工圈定的**只读子集**（read/grep/find/ls），不含 write/edit/bash；而 `spawn_agent`、`list_agents`、`wait_agent` 这三个监督工具只注册给根代理的注册表，工作线程永远收不到它们，递归派生从结构上不可能发生。

第四波的 MCP 工具适配器处理命名冲突的策略是：裸名可用则直接用；冲突则加服务器名前缀成 `<server>_<tool>`；双重病态冲突直接跳过。整个 MCP 阶段被 `if (Object.keys(mcpServers).length > 0)` 包裹且注释明言"失败记录、绝不致命"——某个 stdio 服务器连不上不会阻断整个产品的启动。

Sources: [bootstrap.ts](src/bootstrap.ts#L115-L153), [adapter.ts](src/mcp/adapter.ts#L10-L25), [agents/tools.ts](src/agents/tools.ts#L9-L14)

## 系统提示词的三路输入

运行时构造前的最后一块拼图是系统提示词，它由三个独立来源合成：

1. **平台指纹**：操作系统、架构、Node 版本，一行内联；
2. **项目记忆**：`readProjectMemory()` 依次尝试读取 `TINY.md`、`AGENTS.md`、`CLAUDE.md`，存在即以 `### 文件名` 为标题拼接——TINY.md 是标准，后两者是对既有工具生态的兼容性兜底；
3. **技能摘要**：`skills.summary()` 只输出 name/description 行，全文留给 `load_skill` 按需加载。

配套的还有默认摘要器 `makeDefaultSummarizer`：自动压缩触发时会用它对旧转录发起一次独立的 LLM 调用（专用系统提示词要求产出密集交接笔记），失败时返回 `(summary failed: ...)` 字符串而不是抛异常——压缩失败不应杀死对话。

Sources: [bootstrap.ts](src/bootstrap.ts#L155-L162), [bootstrap.ts](src/bootstrap.ts#L206-L242)

## 最终合体：五个钩子在 RuntimeOptions 处汇流

第 8 步把前面所有产物打包进 `RuntimeOptions` 传给 `TinyCodeRuntime`，后者在构造 Pi `Agent` 时完成五路策略挂接：

| Agent 构造参数 | 注入的策略 | 来源子系统 |
|---|---|---|
| `streamFn` | 认证解析后的流式函数 | ModelRegistry |
| `initialState.systemPrompt/model/tools` | 提示词、模型、工具快照 | 第 1/6/7/8 步 |
| `transformContext` | 自动压缩（含摘要器） | ContextManager + Summarizer |
| `beforeToolCall` | 权限闸门，deny 时携带原因阻断 | PermissionManager |
| `afterToolCall` | 工具结果截断与工件归档 | ContextManager |
| `subscribe`（条件） | message_end 事件落盘会话 | SessionManager |

`subscribe` 是唯一条件挂接的钩子——没有会话选项时订阅根本不建立，无头 `-p` 默认不留痕正是从这里开始生效的。另有一处细节：`thinkingLevel` 设为 `"minimal"` 而非 `"off"`，注释说明部分托管端点会拒绝显式禁用推理的请求。

Sources: [runtime.ts](src/agent/runtime.ts#L16-L65)

## 收尾协议：shutdown 的逆序释放

`Harness.shutdown()` 的实现只有两行，却体现了资源释放的正确顺序：先关 MCP 再停子代理。MCP 持有外部 stdio 进程，属于最外层的资源；子代理工作线程是进程内的，后释放保证它们不会在 MCP 已死的情况下还尝试调用远程工具。三个 CLI 入口（TUI 主循环、无头模式、listModels）都在结束时 await 这个方法，包括 `--list-models` 这种只为查一次认证状态而完整装配 Harness 的场景——组合根的一致性在这里表现得最为极端。

Sources: [bootstrap.ts](src/bootstrap.ts#L186-L203), [cli/index.ts](src/cli/index.ts#L149-L168)

## 从命令行到 Harness：CLI 层的薄封装

CLI 并不重复任何装配逻辑，`buildHarnessFromCli()` 只做了三件增量的事：加载配置并打印警告、解析 `--model` 标志、以及**后置应用**权限模式。最后一点是个容易忽略的设计选择：bootstrap 内部用的是 `config.permissionMode ?? "ask"`，若用户又给了 `--permission-mode` 标志，CLI 在 Harness 构造完成后调用 `permissions.setMode()` 覆盖——标志的优先级高于配置文件，但不侵入装配过程本身。

两个主入口的消费方式差异鲜明：

- **TUI 路径**先把会话选项解析出来（裸启动→新建；`--continue`→匹配 cwd 的最新会话，找不到则降级为新会话并提示；`--session <id>`→精确挂载），然后构造 Harness，再把它**拆开**喂给 `TuiApp`：`harness.runtime` 为主体，其余管理器作为独立引用传入各自需要的组件。若模型未配置，入口层捕获 `ModelNotConfiguredError` 后用 `mock: true` 重新装配一遍，并把错误信息作为引导提示带进 UI——零配置启动体验在组合边界上实现。
- **无头 `-p` 路径**只在显式要求恢复（`--continue`/`--session`）时才传 session 选项，否则 `undefined`，配合 subscribe 的条件挂接实现"无头运行默认不留会话"。它绕过 TUI，直接向 `harness.runtime.agent.subscribe` 注册一个 `agent_end` 监听来抓取最终文本。

Sources: [cli/commands.ts](src/cli/commands.ts#L56-L88), [cli/index.ts](src/cli/index.ts#L45-L133), [sessions.ts](src/cli/sessions.ts#L17-L40)

## 装配正确性的验证视角

E2E 测试是这套契约的最佳旁证：`tests/harness.e2e.test.ts` 用 `bootstrapHarness` 加 Mock 模型和真实工具跑通 read → edit → bash 全流程，然后断言三件事——工具调用序列符合脚本、编辑产生了真实磁盘变更、会话文件记录了完整转录。能够这样测，正是因为组合根把"装配"从"运行"中剥离了出来：测试拿到的是与生产完全相同的 `Harness`，只是把流式函数换成了脚本。

Sources: [harness.e2e.test.ts](tests/harness.e2e.test.ts#L59-L99)

## 小结与阅读路径

bootstrap 装配的本质是一条**依赖驱动的八步流水线**：模型解析决定上下文预算，技能发现在工具注册之前，会话文件早开晚恢复，四波工具合并构成统一命名空间，最终五个钩子在一个 `RuntimeOptions` 对象处汇入 Pi 代理循环。掌握这条流水线后，后续各页的子系统细节都有了准确的挂载坐标。

建议继续深入的方向：

- 五个钩子的运行期行为详见 [TinyCodeRuntime 解剖：五个策略钩子接入 Pi 代理循环](8-tinycoderuntime-jie-pou-wu-ge-ce-lue-gou-zi-jie-ru-pi-dai-li-xun-huan)
- 统一注册表的命名空间规则展开见 [统一工具注册表：内置、MCP 与子代理工具的命名空间合并](11-tong-gong-ju-zhu-ce-biao-nei-zhi-mcp-yu-zi-dai-li-gong-ju-de-ming-ming-kong-jian-he-bing)
- 模型解析与 Mock 注入的前置知识见 [模型注册表：多提供商选择链与 Mock 模型注入](25-mo-xing-zhu-ce-biao-duo-ti-gong-shang-xuan-ze-lian-yu-mock-mo-xing-zhu-ru)
- 分层职责的全局图景回顾 [分层架构地图：Pi 运行时与 TinyCode 自研层的职责边界](6-fen-ceng-jia-gou-di-tu-pi-yun-xing-shi-yu-tinycode-zi-yan-ceng-de-zhi-ze-bian-jie)