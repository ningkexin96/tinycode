会话持久化是编码智能体最不容出错的子系统之一：用户可能在任意时刻按下 `Ctrl-C`、关闭终端窗口，甚至直接杀掉进程，而对话历史必须在这些打击下幸存。TinyCode 用三个极小的模块回答了这个问题——`SessionStorage`（纯磁盘语义）、`SessionManager`（内存会话状态绑定）、`types.ts`（判别联合定义记录格式），总计不到 250 行代码。本页剖析这套设计的核心决策：**为什么选择每会话一个 JSONL 文件、只追加不重写的写入模型，以及读取端如何用容忍性解析兑现"崩溃安全"承诺**。

Sources: [storage.ts](src/session/storage.ts#L1-L94)

## 设计动机：把进程死亡当作常态

传统持久化方案（如整体重写一个 JSON 文件或引入 SQLite）都隐含一个危险窗口：**修改中途崩溃会留下半新半旧的状态**。追加式写入从第一性原理上消除了这个问题——`append` 操作要么完整落盘，要么在文件尾部留下一行残缺数据，而残缺数据可以通过逐行解析轻松丢弃。这正是 [storage.ts](src/session/storage.ts#L6-L10) 类文档注释所声明的契约：每个会话对应 `<dir>/<id>.jsonl` 一个文件，第 1 行永远是会话头部，其后每一行都是一条消息；追加通过同步刷盘完成，使会话能在硬杀下存活。

这个设计还有两个附带收益。其一是**零依赖**：不需要任何数据库或序列化框架，`node:fs` 的同步 API 就足够；其二是对人类友好——JSONL 文件可以直接用 `grep`、`tail` 检查，故障排查时无需专门工具。

Sources: [storage.ts](src/session/storage.ts#L6-L12), [manager.ts](src/session/manager.ts#L6-L9)

## 磁盘布局：一行一记录的 JSONL 契约

每个会话文件的物理结构由 [types.ts](src/session/types.ts#L3-L17) 中的判别联合 `SessionRecord` 定义：`type: "session"` 的头部行固定占据第 1 行，`type: "message"` 的记录行从第 2 行开始按时间顺序排列。下面是一个典型文件的形态示意：

```jsonl
{"type":"session","id":"0190f3...","cwd":"/Users/helson/work/app","createdAt":"2024-05-01T08:00:00.000Z","model":"anthropic/claude-sonnet-4","title":"fix the login bug"}
{"type":"message","message":{"role":"user","content":"fix the login bug","timestamp":1714540800000}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"..."}],"usage":{...}}}
```

三种类型各司其职，构成完整的存储契约：

| 类型 | 形态 | 角色 |
|---|---|---|
| `SessionHeader` | `{type:"session", id, cwd, createdAt, model, title?}` | 文件第 1 行，标识会话元数据 |
| Message 记录 | `{type:"message", message: AgentMessage}` | 第 2 行起每行一条已定稿消息 |
| `SessionSummary` | `{id, createdAt, modifiedAt, cwd, model, title?, messageCount}` | `list()` 返回的内存投影，不含消息体 |

注意 `title` 是可选字段：会话创建时通常还没有标题，它要等第一条真实用户输入到达后才补写（下文详述）。而 `cwd` 被持久化在头部中，是后续 `--continue` 按"当前目录匹配历史会话"的数据基础。

Sources: [types.ts](src/session/types.ts#L3-L27), [storage.ts](src/session/storage.ts#L22-L32)

`SessionStorage` 对外暴露的方法面刻意保持最小：

| 方法 | 行为 | 关键细节 |
|---|---|---|
| `create(header)` | 写入第 1 行头部 | `writeFileSync` 整文件写入；对同 id 复用即为整文件重写 |
| `appendMessage(id, msg)` | 尾部追加一条消息 | `appendFileSync` 同步刷盘 |
| `load(id)` | 解析出 header + messages | 逐行解析，坏行跳过；无 header 返回 `undefined` |
| `list()` | 全部会话摘要，最新在前 | mtime 排序，stat 失败回退 createdAt |
| `exists(id)` | 文件存在性探测 | 仅检查 `<dir>/<id>.jsonl` 是否存在 |

Sources: [storage.ts](src/session/storage.ts#L14-L36)

## 写入路径：同步追加与"永不抛出"的隔离层

写入侧的核心纪律有两条。第一条是**同步刷盘**：[appendMessage](src/session/storage.ts#L29-L32) 使用 `fs.appendFileSync`，每次调用都会阻塞到操作系统的写系统调用返回后才继续。这意味着进程被 SIGKILL 击中时，所有已完成 `record()` 调用的消息都已在内核缓冲区中，最多只丢失"正在写入途中"的那一条。代价是吞吐——但对每轮对话仅产生几条消息的场景，同步写入的开销完全可以接受。

第二条是**持久化失败绝不传染给活会话**。[SessionManager.record](src/session/manager.ts#L52-L80) 把所有存储调用包裹在 try/catch 中并静默吞掉异常，注释直言其理由："Persistence must never crash the live session."（持久化绝不能搞崩进行中的会话）。测试 [record survives storage failures without throwing](tests/session.test.ts#L104-L111) 验证了极端情况：把底层文件直接删除后继续调用 `record()`，管理器不抛错、会话照常推进——磁盘上的损失被限制在持久层内部。

Sources: [storage.ts](src/session/storage.ts#L29-L32), [manager.ts](src/session/manager.ts#L75-L79), [session.test.ts](tests/session.test.ts#L104-L111)

另一个容易被忽略的设计点是 **attach 的只读性**。[attach](src/session/manager.ts#L33-L50) 用于 `--continue` / `--resume` 场景，它的实现只是加载文件并恢复内存状态，注释解释了为什么不顺手把内存中的 model 等元信息回写到文件：重写"头部 + 完整历史"意味着先截断再重新追加，如果进程恰好死在这两步之间，整个会话就没了。因此**存储中的头部永远保持权威**，即使 attach 时传入的 `_cwd` / `_model` 参数与文件不一致也以文件为准。测试用字节级断言锁定了这一保证——attach 前后文件内容必须完全相同。

Sources: [manager.ts](src/session/manager.ts#L33-L50), [session.test.ts](tests/session.test.ts#L82-L102)

## 标题回写：唯一的重写窗口

整个子系统中只有一处违反"只追加"纪律：标题注入。[record](src/session/manager.ts#L52-L74) 在遇到首条含可提取文本的用户消息且 `titleSet` 为 false 时，会用同一个 id 再次调用 `storage.create()`——由于 `create` 底层是 `writeFileSync`（默认截断模式），这实质上是用带 `title` 的新头部**重建了整个文件**。

这个窗口为何可以接受？关键在时序：该分支只在会话的首条文本用户消息上触发，而正常流程中此时文件里除头行外还没有任何消息行（用户消息是第一个触发 `message_end` 事件的消息），所以重写在效果上等价于"原地补写 title"，无数据损失。此外这条路径同样被 try/catch 包裹——回写失败时标题退化为仅存于内存，追加照常执行。

但严格审视存在一个可观察的边界条件：若首条用户消息不含可提取文本（例如内容块数组拼接后为空），它会走[纯追加分支提前返回](src/session/manager.ts#L57-L60)；随后到达的文本用户消息仍会触发整文件重写，此前已追加的消息行会被丢弃。这是当前实现的真实行为边界，理解它有助于判断哪些异常时序下可能丢消息。

Sources: [manager.ts](src/session/manager.ts#L52-L74), [storage.ts](src/session/storage.ts#L22-L27)

## 读取路径：撕裂行容忍的防御性解析

读取端是崩溃安全的另一半保证。[load](src/session/storage.ts#L38-L63) 的策略可以概括为"逐行独立、坏行跳过"：先按换行切分并过滤空行，然后对每一行单独 `JSON.parse`——解析失败的行被 `continue` 跳过而不是让整个加载失败，注释明确写着 "skip torn/corrupt lines instead of losing the whole session"。最后若找不到任何 `type: "session"` 头部行则返回 `undefined`，调用方据此将文件视为不存在。

这套容忍逻辑正是为追加式写入的固有风险量身定做的：进程死在 `appendFileSync` 中途时，文件尾部可能留下形如 `{"type":"message","message":{"role":"user"` 的半截 JSON。下一次加载时这行会被静默丢弃，损失被精确限定在那一条消息上。测试 [tolerates torn lines](tests/session.test.ts#L45-L54) 手工构造了这样的残缺尾行，断言头部和已有消息完好无损地加载回来。

值得强调的是**防御性解析与追加式写入是共生关系**：如果采用"整体重写"模型，中途崩溃留下的将是语法非法的整个文件，无法局部恢复；而 JSONL 的行独立性使得损坏的影响半径天然等于单行。

Sources: [storage.ts](src/session/storage.ts#L38-L63), [session.test.ts](tests/session.test.ts#L45-L54)

`list()` 建立在 `load()` 之上做全目录聚合：遍历目录下所有 `.jsonl` 文件逐一加载，跳过无效文件，然后用文件系统的 mtime 作为 `modifiedAt`（stat 失败时回退到头部中的 `createdAt`），最终按 modifiedAt 字符串倒序排列——ISO 8601 格式的字典序即时间序，所以字符串比较就是正确的排序。测试通过 `utimesSync` 固定 mtime 验证了"最新优先"顺序。

Sources: [storage.ts](src/session/storage.ts#L65-L92), [session.test.ts](tests/session.test.ts#L56-L67)

## 崩溃场景推演矩阵

把上述机制组合起来，可以对各类崩溃时机做一次系统推演：

| 崩溃时机 | 防护机制 | 最坏结果 |
|---|---|---|
| 消息追加途中被硬杀 | 同步 append + 读取端跳过撕裂行 | 丢失正在写入的那一条消息 |
| 只写了头行就被杀 | load() 无 header 即视为无效文件 | 该会话不出现在列表中 |
| attach 之后立即崩溃 | attach 全程只读，不触碰文件 | 文件字节级不变，无损 |
| 存储目录或文件被删 | record() 吞掉全部写异常 | 会话仅在内存中继续，对话不中断 |
| 标题回写时崩溃 | 回写发生在文件近乎为空时；异常也被捕获 | 至多丢失标题，或罕见时序下的早期消息行 |

可以看到，所有场景的最坏损失都被约束在"单条消息"或"单个字段"粒度，**不存在任何能摧毁整个会话历史的路径**——这就是"崩溃安全"在此架构中的确切含义。

Sources: [storage.ts](src/session/storage.ts#L38-L63), [manager.ts](src/session/manager.ts#L40-L50)

## 子系统接线：从 message_end 事件到落盘

存储层并不主动感知代理循环，而是通过事件订阅被动挂接。[bootstrap](src/bootstrap.ts#L104-L113) 在装配阶段创建 `SessionManager` 并根据 CLI 参数决定 `start` 新会话还是 `attach` 既有会话；随后 [TinyCodeRuntime](src/agent/runtime.ts#L57-L64) 向 Pi Agent 订阅事件流，凡遇 `message_end` 事件就把已定稿的消息交给 `session.record()`。

```mermaid
flowchart LR
    subgraph W["写入侧"]
        RT["TinyCodeRuntime<br/>订阅 message_end"]
        SM["SessionManager.record<br/>标题注入 + 异常吞噬"]
    end
    subgraph S["存储层"]
        SS["SessionStorage<br/>create / appendMessage / load / list"]
        FS[("~/.tinycode/sessions/&lt;uuidv7&gt;.jsonl")]
    end
    subgraph C["消费侧"]
        BS["bootstrap 装配<br/>start 或 attach"]
        CS["cli/sessions<br/>按 cwd 过滤 list 结果"]
    end
    BS --> SM
    RT --> SM --> SS --> FS
    SS -.-> CS
```

存储目录由 [sessionsDir](src/config/loader.ts#L14-L16) 决定：优先取环境变量 `TINYCODE_HOME`，否则落在 `~/.tinycode/sessions`。会话 id 由 [start](src/session/manager.ts#L24-L31) 通过 `uuidv7()` 生成——v7 版本的 UUID 内嵌毫秒级时间戳，天然按创建时间有序，作为文件名兼具唯一性与可读性。

还有一个跨子系统的架构事实值得记录：**JSONL 文件是完整的历史账本，上下文压缩不会改写它**。[compactNow](src/agent/runtime.ts#L89-L97) 只在内存中原地替换 `agent.state.messages`，全程不触碰 SessionStorage——压缩改变的是模型可见的视图，而磁盘上的每一轮原始对话永久保留。这与[工具结果截断策略](17-gong-ju-jie-guo-jie-duan-ce-lue-tou-wei-bao-liu-yu-wan-zheng-shu-chu-gui-dang-wei-gong-jian)一脉相承：内存视图可以做有损优化，持久账本保持无损。

Sources: [bootstrap.ts](src/bootstrap.ts#L104-L113), [runtime.ts](src/agent/runtime.ts#L57-L64), [loader.ts](src/config/loader.ts#L14-L16), [runtime.ts](src/agent/runtime.ts#L89-L97)

## 测试锚定的不变量

这套设计的每条保证都有对应的测试锚点，形成一张清晰的"不变量清单"：

| 不变量 | 测试 | 断言方式 |
|---|---|---|
| 写入后可完整读回 | round-trips header and messages | 头部字段 + 消息数量与内容比对 |
| 撕裂行不毁会话 | tolerates torn lines | 手工追加半截 JSON 后断言 header 与消息存活 |
| 列表最新优先 | lists sessions newest-first | utimesSync 固定 mtime 后验证排序 |
| attach 零副作用 | attach restores the transcript without touching the file | attach 前后文件字节级相等 + attach 后追加继续生效 |
| 写失败不传染 | record survives storage failures | 删除底层文件后 record 不抛错 |

特别值得学习的是 [attach 测试](tests/session.test.ts#L82-L102)的写法：它没有停留在"功能正确"层面（能恢复消息），而是进一步断言**文件内容在 attach 前后完全一致**，并在注释中写明理由——"a crash during attach can never destroy a session"。这是把并发/崩溃语义写成回归测试的典范做法。

Sources: [session.test.ts](tests/session.test.ts#L31-L112)

## 小结与延伸阅读

TinyCode 的会话持久化展示了"简单机制 + 严格纪律"的组合拳：JSONL 的行独立性提供了天然的损坏隔离单元，同步追加消除了部分写窗口，容忍性解析兜住了残余风险，而"持久化永不抛出"与"attach 永不重写"两条纪律封死了数据丢失的主要通路。整套方案没有任何一处用到锁、事务或外部依赖，却达成了多数数据库才敢承诺的存活 guarantee。

理解了存储格式之后，下一步自然是追问会话如何被选中与轮换——`--continue` 如何按目录匹配、`--session <id>` 如何精确定位、`/new` 如何轮换文件，这些生命周期问题在下一页展开：[会话生命周期：新建、--continue 目录匹配与 /new 轮换](20-hui-hua-sheng-ming-zhou-qi-xin-jian-continue-mu-lu-pi-mai-yu-new-lun-huan)。想了解 bootstrap 装配阶段如何把 SessionManager 编入全局 Harness，可回看 [Harness 装配流程：bootstrap 如何串联全部子系统](7-harness-zhuang-pei-liu-cheng-bootstrap-ru-he-chuan-lian-quan-bu-zi-xi-tong)。