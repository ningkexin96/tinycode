TinyCode 的会话生命周期由三个层次协作完成：**CLI 解析层**将命令行参数折叠为一个二选一的 `SessionOption`，**装配层**据此决定调用 `start()` 还是 `attach()`，**TUI 运行时层**则通过 `/new`、`/resume` 等斜杠命令在进程存活期间轮换会话。本文剖析这条完整链路的行为契约与背后的设计取舍——包括为什么 `--continue` 永远不会恢复另一个项目的会话，以及为什么 `/new` 之后工具调用依然可用。

## 三段式生命周期：解析、装配、运行时轮换

整个生命周期可以概括为一台状态机。启动时，`resolveInteractiveSession()` 把三种入口参数归约为 `{ mode: "new" }` 或 `{ mode: "attach", id }` 两种形态；bootstrap 拿到该选项后分别触发 `session.start()`（生成全新会话文件）或 `session.attach()`（只读加载既有历史）；进入 TUI 后，`/new` 在两种状态间自由切换且旧文件永不销毁。

```mermaid
stateDiagram-v2
    [*] --> NewSession : tinycode（裸启动，总是新建）
    [*] --> Attach : --continue（cwd 匹配成功）
    [*] --> NewSession : --continue（无匹配，stderr 提示后新建）
    [*] --> Attach : --session &lt;id&gt;
    [*] --> NoPersistence : -p 无 --continue/--session
    NewSession --> NewSession : /new（轮换文件 + 清空上下文）
    NewSession --> Attach : /resume &lt;id&gt;
    Attach --> NewSession : /new
    Attach --> Attach : /resume &lt;id&gt;
```

图中状态均指"当前活跃的持久化目标"。`NoPersistence` 是一次性模式的特殊分支——没有会话对象时，代理循环照常运转但不落盘。测试文件的头部注释精确记录了这份行为清单：裸启动得到活跃新会话、`--continue` 仅限当前 cwd、`/new` 换 id 并清空上下文但 harness 完好、`/resume` 用目标会话替换活上下文。

Sources: [sessions.ts](src/cli/sessions.ts#L6-L16)、[session-lifecycle.test.ts](tests/session-lifecycle.test.ts#L10-L17)

## CLI 解析层：一个纯函数决定起点

`resolveInteractiveSession()` 是一个无副作用的决策函数，输入是 `Pick<CliArgs, "continueLast" | "sessionId">` 加上当前工作目录，输出是 `SessionOption` 判别联合。优先级清晰：`--continue` 先于 `--session` 检查，两者皆缺省时返回 `{ mode: "new" }`。参数本身由 `parseArgs` 从 `--continue` 和 `--session <id>` 两个旗标解析而来。

| 启动方式 | 解析结果 | 特殊行为 |
|---|---|---|
| `tinycode` | `{ mode: "new" }` | 总是新会话，无条件 |
| `tinycode --continue` | `{ mode: "attach", id }` 或 `{ mode: "new" }` | 无匹配时向 stderr 打印提示并降级为新建 |
| `tinycode --session <id>` | `{ mode: "attach", id: "<id>" }` | 直接附加指定 id |
| `tinycode -p "<prompt>"` | `undefined`（除非带 `--continue`/`--session`） | 不落盘 |

值得注意的是降级策略：`--continue` 找不到可续接的会话时不抛错、不让启动失败，而是写一行 `"no previous session to continue — starting a fresh one."` 到 stderr 后照常以新会话启动。这保证了 `--continue` 可以作为"尽力续接"的默认习惯使用，即使在新克隆的目录里也不会阻塞工作流。

Sources: [sessions.ts](src/cli/sessions.ts#L17-L44)、[args.ts](src/cli/args.ts#L41)、[args.ts](src/cli/args.ts#L47)

## --continue 目录匹配：mtime 倒序下的首个同 cwd 会话

`pickLatestSessionForCwd()` 的实现只有一行核心逻辑：在 `manager.list()` 的结果上执行 `find((session) => session.cwd === cwd)`。它的正确性依赖两个上游保证。其一，`SessionStorage.list()` 对所有 `<id>.jsonl` 文件按 `modifiedAt`（取自文件系统的 mtime）做 ISO 字符串倒序排序，因此线性扫描遇到的第一个匹配就是**该目录下最近修改**的会话。其二，匹配采用严格的字符串相等——会话头中的 `cwd` 字段记录的是创建时的项目根目录，`--continue` 只认完全一致的值，跨项目恢复在结构上不可能发生。

```mermaid
sequenceDiagram
    participant U as 用户
    participant R as resolveInteractiveSession
    participant S as SessionStorage.list()
    participant F as 文件系统
    U->>R: --continue + 当前 cwd
    R->>S: list()
    S->>F: readdirSync + statSync(mtime)
    S-->>R: 按 mtime 倒序的摘要数组
    R->>R: find(s => s.cwd === cwd)
    alt 命中同目录会话
        R-->>U: { mode: "attach", id }
    else 无任何匹配
        R-->>U: stderr 提示 + { mode: "new" }
    end
```

回归测试通过 `fs.utimesSync` 人为制造确定性的 mtime 差异来验证"最新优先"：三个会话中全局最新的是 B 项目，但 A 项目下较新的那个会被选中而非更旧的。另一个测试则验证隔离性——即便 B 项目拥有全局最新会话，在 A 项目目录执行 `--continue` 也只会命中 A 自己的历史。需要说明的是，`modifiedAt` 取自 mtime 而非消息内容，因此任何对会话文件的追加（包括其他进程的读取不会，但写入会）都会刷新其"新鲜度"。

Sources: [sessions.ts](src/cli/sessions.ts#L19-L24)、[storage.ts](src/session/storage.ts#L65-L92)、[types.ts](src/session/types.ts#L4-L13)、[session-lifecycle.test.ts](tests/session-lifecycle.test.ts#L35-L70)

## 新建路径：uuidv7 标识与延迟标题回写

`SessionManager.start()` 为每个新会话生成 **uuidv7**（时间有序的 UUID 变体），立即通过 `storage.create()` 写入第一行 JSONL 头部——包含 id、cwd、createdAt 与模型引用——并在内存中维护一份 `meta`（含 `titleSet: false` 标志）。此时文件只有一行头记录，还没有任何消息。

标题的写入采用了延迟策略：`record()` 在收到**第一条携带可提取文本的用户消息**时，才用该文本片段重写文件头作为人类可读的标题（供 `/sessions` 列表展示）。这里有一个精妙的约束：`storage.create()` 底层用的是 `writeFileSync`，即截断重写整个文件。这个操作之所以安全，是因为它被 `titleSet` 标志严格限定在"新会话首条用户消息到达前"的窗口内——彼时文件里除头行外没有任何消息，截断无损。一旦进入 `attach` 场景，`meta.titleSet` 被置为 `true`，这条重写路径被永久关闭。若标题提取失败或重写抛错，代码选择静默容忍：标题退化为仅存于内存，消息照常追加，持久化故障永远不会击穿活跃会话。

```mermaid
flowchart LR
    A[start&#40;&#41;<br/>uuidv7 + 写头行<br/>titleSet=false] --> B{record&#40;&#41; 收到<br/>用户消息?}
    B -- 否 --> C[直接追加 JSONL]
    B -- 是 --> D{能提取文本?<br/>且 titleSet=false}
    D -- 是 --> E[writeFileSync 重写头<br/>带上 title<br/>titleSet=true]
    D -- 否 --> C
    E --> C
    C --> F[appendFileSync<br/>同步刷盘]
```

Sources: [manager.ts](src/session/manager.ts#L24-L31)、[manager.ts](src/session/manager.ts#L52-L80)、[manager.ts](src/session/manager.ts#L91-L104)、[storage.ts](src/session/storage.ts#L22-L32)

## attach 的只读契约：为什么存储头保持权威

`SessionManager.attach()` 的注释明确声明了一个反直觉的设计：附加到已有会话时**不重写文件头**，哪怕当前启动参数里的 cwd 和模型可能与头中记录不同。理由写在注释里——如果在此处重写头部加全量历史，而进程恰好死在截断与重新追加之间，会话文件就会被拦腰斩断。因此磁盘上的原始头部永远是权威版本，`attach` 只做三件事：加载全部消息返回给调用方、把内存指针切到目标 id、从存储头重建 `meta` 并标记 `titleSet: true`（顺带从第一条用户消息提取摘要文本用于展示）。附带的好处是：`--continue` 恢复的会话保留其诞生时的 cwd 与模型指纹，历史信息不失真。

这与上一节的标题回写形成互补的完整性保护：**写路径**上，截断式重写只在空窗口期发生；**挂载路径**上，根本不给截断机会。两条规则共同守住了"追加式存储崩溃安全"的不变量——这也是第 19 篇《追加式 JSONL 存储》的核心主题。

Sources: [manager.ts](src/session/manager.ts#L33-L50)

## /new 轮换：换的是文件，不是 harness

TUI 中输入 `/new` 时，`executeSlashCommand()` 依次执行两个动作：`ctx.startNewSession()`（内部调用 `session.start(projectRoot, 当前模型)` 生成新 id）和 `ctx.runtime.agent.reset()`（清空代理循环内的对话上下文）。关键在于**没有被触碰的东西**：模型实例、工具注册表、系统提示词全部原样保留。测试对此有专门断言——`/new` 前后 `agent.state.model` 相同、`tools.names()` 序列相同、systemPrompt 长度大于零，并且紧接着发起一次 read 工具调用仍能成功返回文件内容。

```mermaid
sequenceDiagram
    participant U as 用户
    participant SL as executeSlashCommand
    participant APP as TuiApp.startNewSession
    participant SM as SessionManager
    participant AG as agent.reset&#40;&#41;
    U->>SL: /new
    SL->>APP: startNewSession&#40;&#41;
    APP->>SM: start&#40;projectRoot, model&#41;
    SM-->>APP: 新 uuidv7
    SL->>AG: reset&#40;&#41;
    Note over AG: 消息清空，模型/工具/系统提示不变
    SL-->>U: "Started new session xxxxxxxx."
```

轮换后的写入隔离由测试逐字节验证：旧文件包含旧消息且不含新消息，新文件反之。这意味着 `/new` 不是删除而是**分叉**——旧会话文件完好保留在 `$TINYCODE_HOME/sessions/` 下，随时可以通过 `/resume <id>` 或下次 `--continue`（前提是它的 mtime 仍是同目录最新）回到它。

Sources: [slash.ts](src/tui/slash.ts#L55-L58)、[app.ts](src/tui/app.ts#L166-L170)、[session-lifecycle.test.ts](tests/session-lifecycle.test.ts#L125-L147)、[session-lifecycle.test.ts](tests/session-lifecycle.test.ts#L149-L183)

## /clear 与 /resume：共享 reset 机制的两个极端

`/clear` 和 `/new` 都会调用 `agent.reset()`，差别仅在于前者**不**轮换会话文件——`SessionManager` 的 currentId 保持不变，后续消息继续追加到同一个 JSONL 文件里。`/resume` 则走另一条路径：先 `attach(id)` 加载目标会话的全部消息，再用 `splice(0, length, ...messages)` 整体替换活上下文数组，此后所有新消息追加到被恢复的那个文件末尾。三者对比：

| 维度 | `/clear` | `/new` | `/resume <id>` |
|---|---|---|---|
| 会话文件 | 不变 | 轮换到新 uuidv7 | 切换到目标 id |
| 代理上下文 | 清空 | 清空 | 替换为目标历史 |
| 旧数据去向 | 继续累积在同一文件 | 旧文件封存保留 | 原文件不受影响 |
| 后续写入目标 | 原 id | 新 id | 目标 id |

`/resume` 不带参数时会列出最近 10 个会话（含 id 与标题）作为用法提示；`/sessions` 则最多列出 20 条带修改时间与消息数的摘要。测试验证了完整的跨会话切换：先恢复会话 B，再切换到会话 A 后，上下文中只存在 A 的历史，且后续追问正确地追加到 A 的文件（文件尺寸增长）。

Sources: [slash.ts](src/tui/slash.ts#L60-L85)、[app.ts](src/tui/app.ts#L155-L164)、[session-lifecycle.test.ts](tests/session-lifecycle.test.ts#L185-L237)

## -p 无头模式的持久化边界

一次性模式对会话的态度截然不同：只有显式携带 `--continue` 或 `--session <id>` 时才会构建会话对象并落盘，否则 `session` 为 `undefined`——代理循环正常执行，但什么都不写。代码注释给出了动机：无头运行的持久化应该是一种明确的恢复意图，而不是每次脚本调用都在磁盘上留下碎片。这与交互模式"总是拥有会话"的哲学形成对照（后者连未配置 API key 的情况都会降级到 mock 模式启动以保证会话体验连续）。

Sources: [index.ts](src/cli/index.ts#L102-L109)、[index.ts](src/cli/index.ts#L45-L49)

## 延伸阅读

理解了生命周期之后，建议按以下顺序深入相邻主题：

- 想了解会话文件在磁盘上的格式细节与容错解析（撕裂行跳过、同步刷盘），请阅读 [追加式 JSONL 存储：崩溃安全的会话持久化设计](19-zhui-jia-shi-jsonl-cun-chu-beng-kui-an-quan-de-hui-hua-chi-jiu-hua-she-ji)
- 想了解 `/new`、`/resume` 所处的斜杠命令体系全貌，请阅读 [交互式 TUI 使用指南：快捷键、输入与斜杠命令](4-jiao-hu-shi-tui-shi-yong-zhi-nan-kuai-jie-jian-shu-ru-yu-xie-gang-ming-ling)
- 想了解 -p 模式下权限默认拒绝等无头特有语义，请阅读 [一次性模式：无头运行与权限默认拒绝语义](5-ci-xing-mo-shi-p-wu-tou-yun-xing-yu-quan-xian-mo-ren-ju-jue-yu-yi)
- 想了解这些生命周期如何被离线 E2E 测试驱动验证，请阅读 [全离线测试策略：脚本化 Mock 模型驱动真实代理循环的 E2E](26-quan-chi-xian-ce-shi-ce-lue-jiao-ben-hua-mock-mo-xing-qu-dong-zhen-shi-dai-li-xun-huan-de-e2e)