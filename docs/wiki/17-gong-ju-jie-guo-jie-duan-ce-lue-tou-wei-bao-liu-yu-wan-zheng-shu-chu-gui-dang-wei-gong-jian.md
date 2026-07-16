本页解释 TinyCode 如何控制进入模型上下文的工具结果体积——这是上下文工程的第一道闸门。核心设计是一个双层结构：工具执行时先做**流式捕获上限**保护进程内存，随后由 `ContextManager` 在 `afterToolCall` 钩子里对超大结果做**头尾保留截断**，并把完整输出归档为磁盘上的工件文件供人事后查阅。截断发生在会话持久化之前，因此会话文件里存的是精简后的文本，工件是唯一的完整副本。本页聚焦单条结果的尺寸控制；整个会话级的 token 预算与自动压缩由下一页承接。

Sources: [tool-results.ts](src/context/tool-results.ts#L4-L10), [manager.ts](src/context/manager.ts#L15-L22)

## 设计动机：日志的信息分布决定截断形态

从第一性原理出发，构建与测试类日志的信息密度并非均匀分布：开头通常是命令回显、环境与配置信息，结尾聚集着错误摘要、失败用例列表与退出码，中间则是大量重复的进度输出。"只保留头部"的传统做法会恰好丢掉最有诊断价值的尾部错误。TinyCode 因此选择**中段截断**——头部与尾部各留一半预算，被丢弃的字符数以显式标记 `[… N characters truncated …]` 写回文本，让模型明确知道中间存在空洞而不是凭空补全。同时，任何被丢弃的内容都不真正消失：完整输出被写入工件文件，并在转录文本末尾追加一行指向该文件的路径，模型和用户都能按需取回全量数据。

Sources: [bash.ts](src/tools/bash.ts#L28-L31), [tool-results.ts](src/context/tool-results.ts#L17-L26), [README.md](README.md#L122-L123)

## 双层防线：内存防线与上下文防线

尺寸控制分布在两个独立的关注点上。**第一层在工具内部**：bash 工具的 `Capture` 类在子进程流式输出过程中维持每流 100,000 字符的捕获上限，目的是防止长时间运行的构建进程把 Node 进程内存撑爆——这与模型上下文无关，即使最终不进上下文也必须设防。**第二层在运行时策略层**：Pi 代理循环每执行完一次工具调用就会触发 `afterToolCall` 钩子，TinyCodeRuntime 把它委托给 `ContextManager.handleAfterToolCall`，后者以 `maxToolResultChars`（默认 30,000 字符）为预算做头尾截断并归档工件。下图展示了从子进程流到会话落盘的完整数据通路：

```mermaid
flowchart TB
    subgraph L1 ["第一层：工具内部捕获上限（内存防线）"]
        PROC["子进程 stdout / stderr 流"] --> CAP["bash.Capture<br/>每流上限 100,000 字符<br/>流式保留头尾各一半"]
        GREP["grep 工具"] --> GCAP["maxResults 条数上限<br/>单行裁剪至 400 字符"]
    end
    subgraph L2 ["第二层：afterToolCall 策略钩子（上下文防线）"]
        RES["AgentToolResult"] --> HOOK["ContextManager.handleAfterToolCall"]
        HOOK -->|"未超预算"| PASS["原样放行<br/>返回 undefined"]
        HOOK -->|"超过 maxToolResultChars"| TM["truncateMiddle<br/>头尾各保留一半<br/>插入省略标记"]
        TM --> ART["saveArtifact 归档完整文本<br/>sessions/artifacts/时间戳-工具名.txt"]
        ART --> PTR["截断文本 + 行内指针<br/>[full output saved to 路径]"]
    end
    CAP --> RES
    GCAP --> RES
    PASS --> MSG["toolResult message<br/>（message_end 事件）"]
    PTR --> MSG
    MSG --> SESS["会话 JSONL 持久化<br/>（只存截断版）"]
    MSG --> CTX["下一次 LLM 请求上下文"]
```

这条流水线的顺序有一个重要推论：Pi 循环在发出 `message_end` 事件之前就已应用 `afterToolCall` 的覆写结果，而 TinyCodeRuntime 的订阅者正是在 `message_end` 时调用 `session.record` 落盘——所以会话文件里永远只有截断后的文本，完整输出的恢复路径只有工件文件一条。

Sources: [bash.ts](src/tools/bash.ts#L6), [runtime.ts](src/agent/runtime.ts#L54), [runtime.ts](src/agent/runtime.ts#L57-L64), [bootstrap.ts](src/bootstrap.ts#L89-L98), [ARCHITECTURE.md](ARCHITECTURE.md#L95-L107)

## 第一层：bash 工具的流式捕获器 Capture

`Capture` 是一个为流式场景设计的环形缓冲变体：每个新 chunk 到达时与已有的头尾拼接，若总长不超过上限就直接并入头部区；一旦溢出，就把头尾各自裁剪为上限的一半，累计丢弃计数并置位 `truncated` 标志。渲染时若发生过丢弃，输出形如 `head\n…\ntail\n[output truncated: N characters omitted]`。bash 工具为 stdout 和 stderr 各实例化一个独立捕获器（各 100,000 字符），这意味着即使一个进程输出数百兆日志，Node 侧驻留内存也被钳制在约 400KB 以内。这里有一个值得注意的边界语义：由于第二层截断作用于工具返回值而非原始进程流，当某条流本身已超过捕获上限时，**工件文件里保存的也只是带省略标记的渲染结果**——第一层丢弃的数据在任何下游都不可恢复。

Sources: [bash.ts](src/tools/bash.ts#L32-L61), [bash.ts](src/tools/bash.ts#L79-L80), [bash.ts](src/tools/bash.ts#L142-L147)

## 第二层：handleAfterToolCall 的覆写流水线

`handleAfterToolCall` 接收 Pi 传入的 `AfterToolCallContext`（含原始执行结果），遍历结果的 content 数组并逐段处理。三个关键分支构成了它的全部逻辑：非 text 类型的内容块（如图像）直接原样返回，永不截断；text 块经 `truncateMiddle` 处理后，若没有丢弃任何字符则保留原对象引用；只有真正发生丢弃的块才会被替换。替换时优先走工件路径——把完整文本写入 `artifactsDir`，再在截断文本尾部追加 `[full output saved to <路径>]` 指针；若磁盘写入失败，`catch` 分支静默降级为纯截断，保证上下文卫生不被归档故障拖累。整条流水线遵循"尽力而为"哲学：截断是确定性承诺，归档是增值服务。

```mermaid
sequenceDiagram
    participant Loop as Pi Agent 循环
    participant CM as ContextManager
    participant FS as 文件系统
    Loop->>CM: handleAfterToolCall(result)
    loop 每个 text 内容块
        CM->>CM: truncateMiddle(text, maxToolResultChars)
        alt droppedChars = 0
            CM-->>Loop: 保留原块
        else 发生丢弃
            CM->>FS: saveArtifact(完整文本)
            FS-->>CM: 工件路径（失败则降级）
            CM-->>Loop: 截断文本 + 工件指针
        end
    end
    alt 全部块均未丢弃
        CM-->>Loop: undefined（完全不覆写）
    else 存在丢弃
        CM-->>Loop: { content, details, isError }
    end
```

覆写的粒度契约由 Pi 定义：返回的 `AfterToolCallResult` 中省略的字段保留原值，不存在深层合并。`ContextManager` 覆写时会显式带上 `details` 与 `isError`，这正是 bash 的退出码、耗时等结构化元数据能在截断后幸存的原因——测试明确断言了 `{ exitCode: 0 }` 在覆写后依然完好。此外还有一个容易被忽略的快路径：当 `droppedTotal === 0` 时方法返回 `undefined`，Pi 会完全跳过覆写逻辑，避免对小结果做无谓的对象重建。

Sources: [manager.ts](src/context/manager.ts#L39-L70), [manager.ts](src/context/manager.ts#L43-L47), [manager.ts](src/context/manager.ts#L49-L60), [types.d.ts](node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L62-L74), [tests/context.test.ts](tests/context.test.ts#L84-L98)

## 头尾保留算法：truncateMiddle 的精确语义

算法本体只有八行，但每一处选择都有明确意图。预算切分为 `keep = Math.floor(maxChars / 2)`，头尾各保留 `keep` 个字符；被丢弃的总数 `dropped = text.length - keep * 2` 以人类可读的形式嵌入标记 `\n\n[… N characters truncated …]\n\n`。三个可验证的性质值得强调：其一，短于预算的文本零改动返回且 `droppedChars` 为 0，这是上游快路径判断的依据；其二，最终文本长度约为 `maxChars` 加上标记本身的约 40 字符开销——测试对 500 字符预算断言了输出小于 1200 字符，说明预算是软上限而非硬上限；其三，标记两侧各有空行分隔，避免截断边界处的残句与标记粘连干扰阅读。单元测试用 `"A"*600 + "MIDDLE" + "B"*600` 构造了一个可判别的夹心结构，断言输出以 AAAA 开头、BBBB 结尾且 MIDDLE 消失，精确锁定了"保两头、弃中间"的行为契约。

Sources: [tool-results.ts](src/context/tool-results.ts#L17-L26), [tests/context.test.ts](tests/context.test.ts#L45-L58), [tests/context.test.ts](tests/context.test.ts#L92-L96)

## 工件归档：saveArtifact 与行内指针

工件命名采用 `<ISO 时间戳>-<工具名>.txt` 格式：时间戳中的冒号与点号统一替换为连字符以兼容跨平台文件名（Windows 不允许文件名含冒号）；工具名经过 `[^\w.-]` 白名单清洗，非法字符一律替换为下划线。存储位置由 `path.join(sessionsDir(), "artifacts")` 决定，展开后即 `$TINYCODE_HOME`（默认 `~/.tinycode`）下的 `sessions/artifacts/`——注意这是**全局共享目录**而非按会话隔离，所有会话的工件混排在一起，靠时间戳前缀天然排序。目录通过 `mkdirSync(recursive)` 惰性创建，首次归档时才落地。归档成功后，截断文本尾部追加的 `[full output saved to <绝对路径>]` 同时服务于两类读者：模型可以据此在同一场对话中用后续工具调用读取完整输出，用户也可以直接打开文件核查。

Sources: [tool-results.ts](src/context/tool-results.ts#L28-L36), [manager.ts](src/context/manager.ts#L52-L56), [bootstrap.ts](src/bootstrap.ts#L97), [loader.ts](src/config/loader.ts#L10-L16)

## 配置入口与默认值

本策略的唯一配置入口是 `config.json` 中 `context.maxToolResultChars`，schema 层约束为正整数，bootstrap 层提供 30,000 字符的默认值。按项目约 chars/4 的确定性 token 估算口径，这相当于给单条工具结果划出约 7,500 token 的最坏情况预算——相对于动辄数十万 token 的现代上下文窗口，单条结果占比被压在个位数百分比。同一 `context` 对象下的 `compactAboveTokens` 与 `keepRecentMessages` 属于会话级压缩策略，不在本页展开。

| 配置项 | schema 约束 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `context.maxToolResultChars` | 正整数 | `30_000` | 单条工具结果在转录中的字符预算，超出部分头尾各留一半 |

Sources: [schema.ts](src/config/schema.ts#L23-L32), [bootstrap.ts](src/bootstrap.ts#L91-L98), [ARCHITECTURE.md](ARCHITECTURE.md#L145-L149)

## 尺寸控制的三种模式对比

把视野放宽到整个工具体系，TinyCode 实际上并存三种尺寸控制模式，它们作用在不同环节、服务不同目标。理解它们的分工有助于回答"为什么我的输出在这一层被剪掉了"这类问题：

| 模式 | 代表实现 | 作用位置 | 信息损失 | 设计目标 |
| --- | --- | --- | --- | --- |
| 流式捕获上限 | `bash` 的 `Capture`（100K/流） | 工具执行期 | 超限部分永久丢失 | 保护进程内存，与模型无关 |
| 结果条数/行长限制 | `grep`（maxResults 条数、单行 400 字符） | 工具执行期 | 有界且带 `truncated` 标记 | 结构化输出的预防性瘦身 |
| 转录层头尾截断 | `ContextManager.afterToolCall`（默认 30K） | 结果定稿期 | 无损失（工件归档兜底） | 控制进入模型上下文的体积 |

第三种模式与前两种有本质区别：它是唯一具备**无损兜底**的一层。而 `read` 工具则展示了第四种思路——根本不做截断，改用 `offset/limit` 参数分页读取大文件，把裁剪决策权交还给模型自身。分层防御的价值在于正交性：即便某个工具忘记做内部限制，第二层仍然守得住上下文预算的上界。

Sources: [bash.ts](src/tools/bash.ts#L32-L61), [grep.ts](src/tools/grep.ts#L79-L86), [grep.ts](src/tools/grep.ts#L99-L107), [read.ts](src/tools/read.ts#L78-L99)

## 边界语义：什么不会被截断，什么不会丢失

四个精确的边界行为构成这套机制的完整性声明。第一，**图像内容豁免**：content 数组中非 text 类型的块绕过全部截断逻辑原样传递。第二，**元数据保真**：覆写返回值显式携带 `details` 与 `isError`，bash 的退出码、信号、时长等诊断信息和错误标记不受文本裁剪影响。第三，**持久化的是截断版**：Pi 循环在应用覆写之后才构造 `toolResultMessage` 并发出 `message_end`，会话 JSONL 因此保持精简，这也意味着重载历史会话时看到的正是模型当时看到的内容。第四，**钩子自身的异常安全**：虽然 Pi 会把 `afterToolCall` 内抛出的异常转换为错误型工具结果，但 `saveArtifact` 的写入已被本地 `try/catch` 包裹，磁盘故障只会导致归档降级而不会污染工具结果。

Sources: [manager.ts](src/context/manager.ts#L43-L44), [manager.ts](src/context/manager.ts#L65-L69), [manager.ts](src/context/manager.ts#L57-L59), [agent-loop.js](node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L481-L512)

## 测试锚点

`tests/context.test.ts` 用五个用例锁定了上述契约：纯函数层面覆盖短文本零改动、头尾保留加显式标记、工件文件内容与长度一致；钩子层面覆盖小结果透传（断言返回 `undefined`）与大结果覆写（断言输出长度受控、包含工件指针、`details` 原样保留）。测试通过 `mkdtempSync` 为每次运行创建独立的临时工件目录，验证过程完全离线，与项目的整体离线测试策略保持一致。这些测试的存在意味着对本策略的任何修改——比如调整标记格式或归档降级行为——都会在 CI 门禁处被立即拦截。

Sources: [tests/context.test.ts](tests/context.test.ts#L38-L64), [tests/context.test.ts](tests/context.test.ts#L67-L98)

## 小结与延伸阅读

工具结果截断策略的本质是一次**信息论取舍**：用可预期的中间内容损耗换取确定性的上下文预算上界，再用零成本的磁盘归档把损耗降为名义值。两层防线各司其职——工具层守住内存，策略层守住上下文，工件目录守住真相。理解了单条结果的控制之后，自然的下一步是会话级的视角：当所有结果都在预算内、累积体积依然超标时会发生什么？这由 Token 预算与自动压缩接管；而截断文本如何随 `message_end` 事件落入 JSONL 文件，则在会话持久化设计中详述。

- 想了解 `afterToolCall` 与其他四个钩子的完整协作关系，请阅读 [TinyCodeRuntime 解剖：五个策略钩子接入 Pi 代理循环](8-tinycoderuntime-jie-pou-wu-ge-ce-lue-gou-zi-jie-ru-pi-dai-li-xun-huan)
- 想看工具调用从流式响应到结果定稿的全流程，请阅读 [代理循环与工具执行流水线：从流式响应到结果落盘](9-dai-li-xun-huan-yu-gong-ju-zhi-xing-liu-shui-xian-cong-liu-shi-xiang-ying-dao-jie-guo-luo-pan)
- 各内置工具的参数级行为契约（含 `read` 的分页语义）见 [七大内置工具详解：read/edit/bash 等的行为契约](10-qi-da-nei-zhi-gong-ju-xiang-jie-read-edit-bash-deng-de-xing-wei-qi-yue)
- 会话级预算与摘要压缩是本页的自然续篇：[Token 预算与自动压缩：会话摘要生成与保护窗口](18-token-yu-suan-yu-zi-dong-ya-suo-hui-hua-zhai-yao-sheng-cheng-yu-bao-hu-chuang-kou)
- 截断文本的落盘载体详见 [追加式 JSONL 存储：崩溃安全的会话持久化设计](19-zhui-jia-shi-jsonl-cun-chu-beng-kui-an-quan-de-hui-hua-chi-jiu-hua-she-ji)