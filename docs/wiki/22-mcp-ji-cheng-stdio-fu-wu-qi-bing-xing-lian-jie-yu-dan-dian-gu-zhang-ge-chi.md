TinyCode 的 MCP（Model Context Protocol）子系统解决一个经典的工程矛盾：外部工具服务器是**不可信的独立进程**，而编码智能体的启动路径必须**永远可达**。本文剖析 `src/mcp/` 下三个模块如何通过有界等待、故障状态化与适配器注入，实现多台 stdio 服务器的并行连接，并确保任何一台服务器的故障都不会演变为整个 Harness 的单点故障。

## 三层结构与数据流向

MCP 子系统由三个职责单一的模块组成，各层之间通过显式接口衔接：`McpClient` 封装单条 stdio 连接并把一切异常转化为可查询的状态；`McpManager` 持有全部客户端并负责并行编排；`registerMcpTools` 适配器把连通服务器的工具翻译成统一的 `AgentTool` 注入注册表。装配入口在 bootstrap 中，仅在配置了 `mcpServers` 时才激活整条链路。

```mermaid
graph TD
    subgraph 配置层
        CFG["config.json → mcpServers"] --> SCHEMA["mcpServerSchema 校验"]
    end
    subgraph "MCP 子系统 src/mcp/"
        MGR["McpManager<br/>clients Map + toolCache"]
        C1["McpClient #1"]
        C2["McpClient #2"]
        CN["McpClient #N"]
        ADP["registerMcpTools 适配器"]
        MGR --- C1
        MGR --- C2
        MGR --- CN
    end
    subgraph 子进程边界
        P1["stdio 服务器 A<br/>JSON-RPC over stdin/stdout"]
        P2["stdio 服务器 B"]
        PN["stdio 服务器 N"]
    end
    subgraph Harness
        BOOT["bootstrap 装配"]
        REG["ToolRegistry 统一注册表"]
        TUI["TUI /mcp 状态命令"]
        SHUT["shutdown 钩子"]
    end
    SCHEMA --> BOOT
    BOOT --> MGR
    BOOT --> ADP
    ADP --> REG
    C1 -.JSON-RPC.-> P1
    C2 -.JSON-RPC.-> P2
    CN -.JSON-RPC.-> PN
    TUI --> MGR
    SHUT --> MGR
```

图中实线为进程内调用，虚线跨越进程边界——每个 `McpClient` 通过官方 SDK 的 `StdioClientTransport` 拉起一个子进程，以 stdin/stdout 承载 JSON-RPC 通信，子进程的 stderr 被设置为 `"pipe"`，与协议通道隔离。

Sources: [manager.ts](src/mcp/manager.ts#L16-L24), [client.ts](src/mcp/client.ts#L44-L50), [adapter.ts](src/mcp/adapter.ts#L12-L26), [bootstrap.ts](src/bootstrap.ts#L146-L153), [schema.ts](src/config/schema.ts#L4-L14)

## 配置契约：仅支持 stdio 的最小模式

配置层用 zod 定义了严格的最小契约：一台服务器只需要 `command` 与可选的 `args`、`env`、`cwd` 和 `timeoutMs`。值得注意的是两个设计取向——v1 明确放弃 HTTP/SSE 等传输方式，注释直接声明"The child process speaks JSON-RPC over stdin/stdout"；`timeoutMs` 被限制在正整数且上限 120 秒，防止配置错误导致启动无限挂起。`mcpServers` 本身是一个以服务器名为键的 record，这个键名后续会出现在工具命名冲突消解和 `/mcp` 状态输出中。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `command` | string | 是 | 可执行文件路径或命令名 |
| `args` | string[] | 否（默认 `[]`） | 命令行参数 |
| `env` | Record&lt;string,string&gt; | 否 | 叠加在 `process.env` 之上的每服务器环境变量 |
| `cwd` | string | 否 | 子进程工作目录 |
| `timeoutMs` | 正整数 ≤ 120000 | 否（默认 10000） | initialize 握手的有界等待时长 |

Sources: [schema.ts](src/config/schema.ts#L4-L14), [schema.ts](src/config/schema.ts#L33-L36)

## McpClient：把异常降级为状态的连接生命周期

`McpClient` 的类注释开宗明义："All failures are captured as state (`status`/`error`) so one broken server never takes TinyCode down"。这是整个隔离模型的基石——客户端对外暴露的不是一个会抛异常的方法集合，而是一台五态状态机：`idle → connecting → connected | error`，终态为 `closed`。

```mermaid
stateDiagram-v2
    [*] --> idle : 构造函数
    idle --> connecting : connect()
    connecting --> connected : initialize 在时限内成功
    connecting --> error : 超时 / 进程启动失败
    connected --> error : listTools 抛出异常
    connected --> closed : close()
    error --> closed : close()
    closed --> [*]
```

连接过程的核心是**有界等待**：`Promise.race` 将 SDK 的 `client.connect(transport)` 与一个定时 reject 的 Promise 同场竞技，超时定时器附带 `.unref()`，避免悬空定时器拖住 Node 事件循环。无论胜负结果如何，`try/catch` 都保证 `connect()` 方法本身正常 resolve——失败的代价只是 `_status` 置为 `"error"` 并记录错误消息，随后尽力而为地 `dispose()` 清理半开连接。这一层自我消化的设计是下一节并行扇出能够安全工作的前提。

Sources: [client.ts](src/mcp/client.ts#L5-L10), [client.ts](src/mcp/client.ts#L38-L66), [client.ts](src/mcp/client.ts#L42-L59)

运行期的两个调用同样遵循"失败即状态/结果"哲学。`listTools()` 捕获一切异常后标记自身进入 `error` 态并返回空数组；`callTool()` 则更进一步——它把响应中的文本内容块拼接为纯文本，非文本内容块只计数并以 `[N non-text content block(s) omitted]` 占位，空结果归一化为 `(empty result)`，而任何抛出的异常都被折叠成 `{ text: "MCP tool call failed: ...", isError: true }`。换言之，**模型看到的永远是合法的工具输出，而不是进程崩溃**。唯一的例外是 `assertConnected()`：它在 `callTool` 进入 try 块之前同步抛错，因此对已断开服务器的调用会将错误上抛给调用方，而非静默降级。

Sources: [client.ts](src/mcp/client.ts#L68-L81), [client.ts](src/mcp/client.ts#L83-L103), [client.ts](src/mcp/client.ts#L116-L120)

## 并行连接：startAll 的扇出与故障吸收

`McpManager.startAll()` 用一条 `Promise.all` 对全部客户端做无顺序依赖的并发连接，每个成功握手的客户端随即拉取工具列表写入 `toolCache`。这里的关键在于：由于 `client.connect()` 内部已将所有异常就地消化，映射函数永远不会 reject，因此 **`Promise.all` 在数学上不可能因任何单个服务器而整体失败**——注释"failures are recorded, never thrown"描述的是结构性保证，而非约定俗成的编程纪律。

```mermaid
flowchart LR
    S["startAll()"] --> F["对所有客户端并发执行"]
    F --> A["client.connect()<br/>Promise.race 有界等待"]
    A -- 握手成功 --> B["listTools 结果写入 toolCache"]
    A -- 失败/超时 --> C["status=error<br/>异常就地消化"]
    B --> D["Promise.all 汇合"]
    C --> D
    D --> E["正常返回，bootstrap 继续"]
```

对称地，`shutdown()` 也以同样的并行扇出关闭全部客户端，由 bootstrap 的 `shutdown` 钩子在退出时调用。若某服务器名在 `callTool` 委托时不存在于 Map 中，管理器会抛出 `Unknown MCP server` ——这是唯一一处向上传播的错误，因为它属于编程期配置错误而非运行期环境故障。

Sources: [manager.ts](src/mcp/manager.ts#L30-L40), [manager.ts](src/mcp/manager.ts#L61-L65), [manager.ts](src/mcp/manager.ts#L67-L69), [bootstrap.ts](src/bootstrap.ts#L199-L202)

## 四道隔离防线的完整矩阵

把前述机制汇总，可以得到一张按故障发生时机划分的隔离矩阵。每一行都对应测试套件中的一个显式用例，零推测、全部可验证：

| 故障场景 | 捕获位置 | 对外表现 | 波及范围 |
|---|---|---|---|
| 进程无法启动 / initialize 超时 | `client.connect()` 的 catch | `status="error"`，错误消息可查 | 仅该服务器，其余照常连接 |
| `listTools` 调用失败 | `client.listTools()` 的 catch | 客户端转 `error` 态，返回空工具列表 | 该服务器工具不进缓存 |
| 工具执行抛异常 | `client.callTool()` 的 catch | 归一化为 `isError:true` 的文本结果 | 模型收到失败提示，循环继续 |
| 配置引用了未知服务器名 | `manager.callTool()` 显式检查 | 抛出 `Unknown MCP server` 错误 | 属配置错误，设计上允许上抛 |

bootstrap 侧的注释"MCP servers (failures recorded, never fatal)"概括了装配语义：即使 `mcpServers` 全军覆没，Harness 依然完成构建，智能体带着剩余的内置工具照常工作。

Sources: [client.ts](src/mcp/client.ts#L61-L65), [client.ts](src/mcp/client.ts#L77-L80), [client.ts](src/mcp/client.ts#L100-L102), [manager.ts](src/mcp/manager.ts#L63), [bootstrap.ts](src/bootstrap.ts#L146-L153)

## 工具注入与命名冲突消解

适配器 `registerMcpTools` 只遍历处于 `connected` 状态的客户端，将其缓存的工具逐一转换为统一的 `AgentTool`。命名规则采用两级回退：目标名字空闲则直接使用原始名；已被占用则加上 `<server>_` 前缀（如内置 `echo` 存在时，mock 服务器的同名工具注册为 `test-mcp_echo`）；连前缀形式也碰撞的病态情况则直接跳过该工具。转换过程中 `normalizeSchema` 保证每个 MCP 工具都携带合法的 object 型 JSON Schema，缺失或不合规的一律替换为宽松的空对象模式。

每个合成工具的 description 会追加来源标注 `(MCP tool provided by server "<server>")`，execute 闭包按 `(serverName, remoteName)` 二元组路由回管理器，并在 `details` 中携带 `mcpServer`/`mcpTool`/`isError` 元数据供下游管线使用。关于这些工具如何与内置及子代理工具在同一注册表中合并排序，详见 [统一工具注册表：内置、MCP 与子代理工具的命名空间合并](11-tong-gong-ju-zhu-ce-biao-nei-zhi-mcp-yu-zi-dai-li-gong-ju-de-ming-ming-kong-jian-he-bing)。

Sources: [adapter.ts](src/mcp/adapter.ts#L12-L26), [adapter.ts](src/mcp/adapter.ts#L28-L51), [adapter.ts](src/mcp/adapter.ts#L53-L58)

## 运行时可观测性：statuses 快照与 /mcp 命令

隔离策略要求配套的可观测面，否则用户无法知道哪台服务器静默失败了。`McpManager.statuses()` 输出包含名称、状态、工具数与错误的快照数组，TUI 的 `/mcp` 斜杠命令将其渲染为逐行图标：`✓` 连接正常、`✗` 出错（附错误后缀）、`…` 其余中间态。未配置任何 MCP 服务器时，命令返回引导信息指向 `.tinycode/config.json → mcpServers`。这套状态查询是只读快照，不触发任何网络或子进程操作。

Sources: [manager.ts](src/mcp/manager.ts#L43-L51), [slash.ts](src/tui/slash.ts#L118-L126)

## 测试如何证明隔离性

集成测试使用一个确定性的 mock stdio 服务器（暴露 `echo` 与必然失败的 `fail` 两个工具），驱动真实子进程走完完整握手。六个用例分别覆盖：连通后状态与工具计数校验、内置 `echo` 冲突时的 `test-mcp_echo` 前缀消解、适配器调用结果与元数据映射、`isError` 语义透传、以及两条隔离性关键断言——**指向不存在二进制的服务器不会让 `startAll()` 崩溃**，和 **shutdown 后所有客户端进入 `closed` 态**。测试中 `timeoutMs: 2000` 的短时限设置还顺带验证了超时路径本身足够快，不会拖垮 CI。

Sources: [server.mjs](fixtures/mock-mcp/server.mjs#L9-L22), [mcp.test.ts](tests/mcp.test.ts#L13-L19), [mcp.test.ts](tests/mcp.test.ts#L32-L46), [mcp.test.ts](tests/mcp.test.ts#L64-L74), [mcp.test.ts](tests/mcp.test.ts#L76-L94)

## 小结

TinyCode 的 MCP 集成展示了一种值得复用的边界处理范式：**在最靠近故障点的层级把异常转化为状态，让上层的并发原语天然免疫单点失败**。`McpClient` 的自我消化、`startAll` 的结构性不失败、适配器的连通过滤三者叠加，构成了从握手、枚举到调用的全周期隔离。退出路径同样对称——并行关闭、尽力清理。理解这条链路之后，下一步可以考察这些工具在真实执行流水线中的权限裁决与结果截断行为：

- [代理循环与工具执行流水线：从流式响应到结果落盘](9-dai-li-xun-huan-yu-gong-ju-zhi-xing-liu-shui-xian-cong-liu-shi-xiang-ying-dao-jie-guo-luo-pan)
- [Harness 装配流程：bootstrap 如何串联全部子系统](7-harness-zhuang-pei-liu-cheng-bootstrap-ru-he-chuan-lian-quan-bu-zi-xi-tong)
- [配置体系：config.json、环境变量与密钥安全管理](3-pei-zhi-ti-xi-config-json-huan-jing-bian-liang-yu-mi-yao-an-quan-guan-li)