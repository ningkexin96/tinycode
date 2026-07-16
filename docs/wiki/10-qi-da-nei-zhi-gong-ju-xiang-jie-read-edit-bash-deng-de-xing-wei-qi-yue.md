TinyCode 向模型暴露的核心能力是七个内置工具：`read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`。本页逐一剖析每个工具的**行为契约**——即参数 schema、输入校验、输出格式、截断语义与错误消息风格之间的隐式约定。这些契约的设计目标高度一致：让模型在无人干预的情况下也能自我纠错（可行动的错误提示）、自我续读（显式的分页提示），并且永远不会拿到无界的输出。路径安全守卫的完整机制在[工作区路径守卫](12-gong-zuo-qu-lu-jing-shou-wei-fu-hao-lian-jie-gan-zhi-de-shuang-ce-realpath-xiao-yan)中单独展开，工具如何与其他来源的工具合并在[统一工具注册表](11-tong-gong-ju-zhu-ce-biao-nei-zhi-mcp-yu-zi-dai-li-gong-ju-de-ming-ming-kong-jian-he-bing)中讨论。

Sources: [index.ts](src/tools/index.ts#L1-L9), [read.ts](src/tools/read.ts#L26-L34)

## 工具全景：七个名字，三类职责

七个工具按职责天然分为三组：**文件读写**（`read`/`write`/`edit`）、**命令执行**（`bash`）和**只读侦察**（`grep`/`find`/`ls`）。下表汇总了每个工具的参数面与关键数值上限——这些数字不是随意的，而是经过推敲的"防失控"预算：

| 工具 | 必选参数 | 可选参数 | 关键上限 | 失败时给模型的指引 |
|------|---------|---------|---------|------------------|
| `read` | `path` | `offset`, `limit` | 默认 2000 行；单行 2000 字符；文件 ≤5MB | 大文件建议改用 bash 的 head/tail/grep |
| `edit` | `path`, `oldText`, `newText` | `replaceAll` | diff 预览封顶 80 行 | 多匹配时要求补充上下文或显式 `replaceAll` |
| `write` | `path`, `content` | — | 无内容上限 | 自动创建父目录 |
| `bash` | `command` | `cwd`, `timeoutMs` | 输出每流 10 万字符；超时默认 120s、上限 600s | 超时先 SIGTERM 后升级 SIGKILL |
| `grep` | `pattern` | `path`, `include`, `ignoreCase`, `maxResults` | 默认 100 条匹配；跳过 >1MB 文件 | 提示可调高 `maxResults` |
| `find` | `pattern` | `path` | 固定 500 条结果 | 结果截断时标注 |
| `ls` | — | `path`, `all` | 500 条目 | 隐藏条目需 `all: true` |

每个工具都以工厂函数形式创建：`createXxxTool(projectRoot)` 返回一个闭包了项目根目录的 `AgentTool` 对象，包含 `name`、`label`、`description`、`parameters`（TypeBox schema）和 `execute` 五个字段。`execute` 统一返回 `{ content, details }`——`content` 是喂回模型上下文的文本，`details` 是结构化元数据供 TUI 渲染使用。

Sources: [bootstrap.ts](src/bootstrap.ts#L115-L128), [read.ts](src/tools/read.ts#L101-L116)

```mermaid
graph TD
    subgraph 文件读写组
        R["read<br/>带行号窗口读取"]
        W["write<br/>创建/整体覆写"]
        E["edit<br/>逐字精确替换"]
    end
    subgraph 执行组
        B["bash<br/>受控 shell 进程"]
    end
    subgraph 只读侦察组
        G["grep<br/>正则搜内容"]
        F["find<br/>glob 找文件"]
        L["ls<br/>目录列表"]
    end
    PG["resolveWorkspacePath<br/>符号链接感知路径守卫"] --> R & W & E & B & G & F & L
    DIFF["diff.ts<br/>LCS 行级差异"] --> E & W
    WALK["walk.ts<br/>目录遍历 + glob 编译"] --> G & F
```

图中所有工具在进入自身逻辑前都先经过同一个入口：`resolveWorkspacePath` 将用户提供的相对路径做词汇解析后，再用双侧 `realpath` 规范化并与项目根的真实位置比对，任何穿透符号链接逃出工作区的尝试都会抛出 `PathOutsideProjectError`。这是全部七个工具共享的第一道闸门，其符号链接感知的完整推导见专页论述。

Sources: [paths.ts](src/tools/paths.ts#L45-L88)

## read：带行号的窗口化读取

`read` 的契约围绕一个核心目标设计：输出中的行号必须能直接复制为后续 `edit` 调用的锚点。它接受 `path` 加可选的 1-based `offset` 和 `limit`（默认窗口 2000 行），每次渲染为 `行号│ 内容` 的格式，行号右对齐占 6 列。

防御性校验按顺序执行四层。首先是 `stat` 阶段的区分错误：`ENOENT` 报 "File not found"，`EACCES` 报 "Permission denied"，目标是目录时报错并明确指示 "Use ls to list it"。其次是体积防线：超过 5MB 的文件直接拒绝，并在错误消息中建议改用 bash 的 `head`/`tail`/`grep`——这是一个典型的"把替代方案写进错误信息"的模式。第三层是二进制检测：读入后若发现 `\0` 字节立即报错，避免把乱码灌入上下文。第四层是单行截断：超过 2000 字符的行被裁剪并追加省略号。

Sources: [read.ts](src/tools/read.ts#L44-L72), [read.ts](src/tools/read.ts#L6-L8)

两个实现细节值得注意。其一，按 `\n` 切分后如果末尾是空字符串（文件以换行结尾的正常情况），会弹出这个"幻影空行"，否则总行数会虚报一行。其二，窗口切片后输出的尾部会给出明确的续读指令：`… N more lines — continue with offset X`——`offset` 的值就是下一窗口的起始行号，模型无需自己计算。空文件的输出则是自描述的 `(empty file)`。头部始终声明总行数与当前展示区间（如 `src/foo.ts (350 lines, showing 1-200)`），使模型对文件规模有全局感。

Sources: [read.ts](src/tools/read.ts#L74-L99)

## edit：逐字匹配的替换协议

`edit` 是七个工具中安全约束最严格的一个，其注释直接写明了三条规则：`oldText` 必须逐字存在（不做模糊匹配）、多处匹配时除非传 `replaceAll: true` 否则失败、成功后返回统一的 diff 预览供验证。这条契约堵住了一个经典事故源——模型以为改了一处，实际静默改写了文件里所有相似片段。

```mermaid
flowchart TD
    A["接收 path / oldText / newText / replaceAll?"] --> B{"文件能读吗？"}
    B -- "ENOENT" --> B1["报错：Use write to create it"]
    B -- "EISDIR" --> B2["报错：Not a file (it is a directory)"]
    B -- 成功 --> C{"oldText 为空？"}
    C -- 是 --> C1["报错：provide the exact text"]
    C -- 否 --> D{"出现次数？"}
    D -- "0 次" --> D1["报错：重新 read 并逐字复制<br/>（空白与缩进都重要）"]
    D -- ">1 且未传 replaceAll" --> D2["报错：补充上下文使其唯一<br/>或传 replaceAll=true"]
    D -- "恰好 1 次，或已传 replaceAll" --> E["split/join 或 replace 写回"]
    E --> F["生成 LCS diff + 统计<br/>返回 +N -M 与预览"]
```

匹配计数用 `current.split(params.oldText).length - 1` 实现，零匹配时的错误消息特别强调 "whitespace and indentation matter"，因为缩进丢失正是模型复制锚文本时最常见的失误。执行替换时，`replaceAll` 走 `split().join()` 全量替换，否则走 `String.replace` 只换第一处。写回成功后用共享的 LCS diff 计算增删行数，`details.replacements` 如实记录实际发生的替换次数（`replaceAll` 时等于匹配数，否则恒为 1）。

Sources: [edit.ts](src/tools/edit.ts#L24-L74), [edit.ts](src/tools/edit.ts#L76-L104)

## write：整体覆写与父目录自动创建

`write` 的契约刻意保持简单：给定完整内容，创建或整体覆盖文件，父目录不存在则递归创建。它与 `edit` 构成互补——修改既有片段用 `edit`（有唯一性保护），从头生成文件用 `write`（无歧义）。事实上 `edit` 在文件不存在时的报错就写着 "Use write to create it"，两个工具的错误消息互相指路。

一个容易被忽略的细节是：写入前如果目标已存在且是常规文件，`write` 会先把旧内容按行读出，写入后再与新内容做一次 LCS diff。因此对已有文件的覆写并非黑箱——模型收到的回报形如 `Overwrote src/x.ts: 42 lines, +3 -5`，能立刻判断覆写是否波及了预期之外的范围。`details.created` 布尔值区分了 "Created" 与 "Overwrote" 两种语义，供 TUI 显示差异化标签。

Sources: [write.ts](src/tools/write.ts#L32-L66), [edit.ts](src/tools/edit.ts#L50-L52)

## bash：进程治理与头尾保留捕获

`bash` 是唯一的进程类工具，其契约要同时解决三个问题：输出爆炸、进程僵死与协作取消。

**输出侧**使用内部 `Capture` 类实现"头尾保留"策略：stdout 与 stderr 各自独立捕获，上限各 10 万字符。未超限时数据线性累积；一旦超限，保留区收缩为首尾各 `cap/2`，中间丢弃量累计计数，最终渲染为 `头部\n…\n尾部\n[output truncated: N characters omitted]`。选择保头留尾是因为构建/测试日志的信息分布规律——开头是配置与环境上下文，结尾是错误摘要，中间往往是大段重复的编译输出。

**进程侧**采用两阶段终止：定时器到期先发 `SIGTERM` 给进程优雅退出的机会，2 秒后若仍未退出则升级为 `SIGKILL` 强杀。外部传入的 `AbortSignal`（例如用户中断会话）复用同一套升级逻辑。`timeoutMs` 参数被钳制在 `[1, 600000]` 区间，默认 120 秒。

Sources: [bash.ts](src/tools/bash.ts#L28-L61), [bash.ts](src/tools/bash.ts#L75-L106)

进程结束后，输出的第一节永远是状态行，四种形态一目了然：超时显示 `✗ TIMEOUT after Nms · killed`；被信号终止显示 `✗ terminated by signal X · 时长`；成功是 `✓ exit 0 · 时长`；失败是 `✗ exit N · 时长`。随后非空的 stdout/stderr 各自成节附上。`BashDetails` 结构化记录了 `exitCode`、`signal`、`timedOut`、`durationMs` 四个字段。需要说明的是，`bash` 本身不做命令危险性判断——每条命令在执行前要过 Shell 风险分类器与权限闸门，那套三级判定与裁决顺序分别在[Shell 风险分类器](13-shell-feng-xian-fen-lei-qi-safe-write-yu-destructive-san-ji-pan-ding)和[权限闸门裁决顺序](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)中展开。

Sources: [bash.ts](src/tools/bash.ts#L113-L147)

## grep / find / ls：只读侦察三件套

三个只读工具共享同一设计母题：**有界搜索**——永远在固定预算内停止，并通过 `truncated` 标志和头部声明告诉模型"还有更多"。

`grep` 接受 JavaScript 语法的正则，非法表达式会得到包含原始错误信息的即时反馈而非崩溃。它的过滤管线值得细看：先用 `include` glob 编译出"全相对路径或纯文件名"双通道匹配器，遍历中依次跳过大于是 1MB 的文件、无法读取的文件和含 `\0` 的二进制文件（这三类都是静默跳过、不中断搜索）。命中行以 `相对路径:行号:内容` 格式输出，内容裁剪到 400 字符且去除首尾空白；达到 `maxResults`（默认 100）后置位 `truncated` 并通过 `"stop"` 信号短路整个目录遍历。头部统计形如 `5 matches for /pattern/ in 23 files`。

Sources: [grep.ts](src/tools/grep.ts#L27-L59), [grep.ts](src/tools/grep.ts#L67-L107)

`find` 做 glob 文件名匹配，语义由共享的 `globToRegExpSource` 定义：`**` 跨目录段（`**/` 编译为可选前缀 `(?:.*/)?`），`*` 不越过 `/`，`?` 匹配单个非分隔符字符。与 `grep` 不同的是它有双通道兜底——模式既测试完整相对路径也测试 basename，因此 `*.test.ts` 能命中任意深度。结果集固定上限 500 条（不暴露为参数），按字母序排序后返回。`ls` 则列出单层目录：隐藏条目默认滤除、目录排在文件前、每项带类型标记（`d`/`f`/`l`，其中 `l` 专门标识符号链接）与人类可读体积（stat 失败时显示 `?` 而非中断）；对文件路径调用 `ls` 会得到 "Not a directory… Use read for files" 的指路错误。

Sources: [find.ts](src/tools/find.ts#L30-L58), [walk.ts](src/tools/walk.ts#L52-L76), [ls.ts](src/tools/ls.ts#L37-L83)

## 共享地基：walkFiles 遍历与 LCS diff

`grep` 与 `find` 的目录遍历共用 `walkFiles`：一个基于队列的广度优先迭代器，硬编码跳过依赖与构建产物目录（`node_modules`、`dist`、`build`、`out`、`coverage`、`.tmp`、`.next`、`.cache`、`__pycache__`、`.venv`、`venv`）以及所有点开头目录，且**绝不跟随符号链接**——这与路径守卫的纵深防御一脉相承。不可读目录被静默跳过，回调返回 `"stop"` 即刻短路整棵树，这正是 `grep` 达到结果上限后不再浪费 I/O 的机制。

Sources: [walk.ts](src/tools/walk.ts#L5-L45)

`edit` 与 `write` 的变更预览则来自零依赖的 `diff.ts`：经典的 LCS 动态规划（`Uint32Array` 表）产出 add/del/ctx 三类行标记，再经 `toHunks` 把长段未变上下文折叠为前后各 3 行的 hunk，最后 `renderDiff` 以 `+`/`-`/空格前缀输出并封顶 80 行，超出部分折叠为 `… (N more diff lines)`。注释明言选择手写而非引库的理由——让初学者能一次读懂，这也契合整个项目"一下午读完"的定位。

Sources: [diff.ts](src/tools/diff.ts#L17-L48), [diff.ts](src/tools/diff.ts#L93-L111)

## 装配位置与只读边界

七个工厂函数在 bootstrap 中按 `read → write → edit → bash → grep → find → ls` 的固定顺序注册进 `ToolRegistry`，注册表保序的特性确保了系统提示词中的工具列表稳定。紧随其后注册的是技能系统的 `load_skill` 工具，再往后才是 MCP 与子代理工具——这一合并视图属于注册表专页的议题。

这里只强调一个与本页直接相关的事实：子代理工作线程拿到的工具集是七个工具的**只读子集**——仅 `read`、`grep`、`find`、`ls` 四个侦察类工具，没有 `write`、`edit`、`bash`。换言之，"七大工具"的能力分级在装配层就被再次收敛了一次：主代理拥有全部七项，子代理只能观察不能改动。

Sources: [bootstrap.ts](src/bootstrap.ts#L115-L144)

## 小结：契约的共同语法

纵观七份实现，可以提炼出一套反复出现的"契约语法"：**入口处**一律经过 `resolveWorkspacePath` 路径守卫；**校验失败时**错误消息永远包含下一步该做什么（use ls / use write / raise maxResults）；**输出永远有界**（行窗口、字符截断、结果上限、diff 封顶），且边界处必附续读或截断声明；**结构化的 `details`** 与文本 `content` 双轨并行，前者服务 TUI 渲染，后者服务模型上下文。理解这套语法后，工具结果如何进一步被截断归档进上下文窗口，请继续阅读[工具结果截断策略](17-gong-ju-jie-guo-jie-duan-ce-lue-tou-wei-bao-liu-yu-wan-zheng-shu-chu-gui-dang-wei-gong-jian)；而七个工具之外的工具如何汇入同一张注册表，见[统一工具注册表](11-tong-gong-ju-zhu-ce-biao-nei-zhi-mcp-yu-zi-dai-li-gong-ju-de-ming-ming-kong-jian-he-bing)。