本页回答一个必须精确理解的问题：TinyCode 到底向用户承诺了什么安全保障，又明确不承诺什么。仓库在三个位置留下了相互印证的声明——面向使用者的 README Security notes、写在实现处的路径守卫注释、以及风险分类器的自我定位注释。三者共同指向同一结论：**权限系统是一道应用内的审批闸门加一个符号链接感知的路径检查，而不是操作系统级的隔离沙箱**。智能体的每一次执行都发生在你自己的用户账号下，拥有你的全部凭据与环境变量。本页逐层拆解这两道机制的真实覆盖面、失效模式，并给出威胁模型对照与运行守则。

Sources: [README.md](README.md#L156-L168)、[paths.ts](src/tools/paths.ts#L5-L18)、[classifier.ts](src/permissions/classifier.ts#L1-L11)

## 一句声明的三个锚点

声明并非营销文案，而是刻意写进代码库三个层面的工程约束。第一处在 [README.md](README.md#L158) 的 Security notes 章节，原文为 "approval layer + workspace path guard, not an OS sandbox"，并紧跟四条边界说明：文件工具通过双侧 realpath 规范化强制项目边界；shell 命令只受风险分类器与审批流程约束而不被监禁；运行真正不可信的代码需要外部沙箱（容器或虚拟机）；API 密钥只应存在于环境变量中。第二处在 [paths.ts](src/tools/paths.ts#L16-L17) 守卫实现的文档注释里，措辞更直白："This is a path guard, not an OS sandbox: bash commands can still touch anything the user's shell can. The permission layer approves those." 第三处在 [classifier.ts](src/permissions/classifier.ts#L8-L10)，自述"deliberately heuristic: its job is to route decisions between ALLOW / ASK, not to be a security sandbox"。把声明放在实现现场而非仅放宣传页，是为了防止未来贡献者在扩展工具时高估这道防线的强度。

Sources: [README.md](README.md#L156-L168)、[paths.ts](src/tools/paths.ts#L5-L18)、[classifier.ts](src/permissions/classifier.ts#L1-L11)

## 两道机制的分工与交汇点

理解声明的关键是看清两道防线各自的管辖范围。**审批层**挂在 Pi Agent 循环的 `beforeToolCall` 钩子上，在*每一个*工具调用执行前介入：静态规则先给出 deny/allow/ask 初判，deny 直接短路返回阻断，ask 则依次经过记忆模式、auto 模式和用户对话框回调，任何一环缺失都安全地退化为拒绝。**路径守卫**则活在各内置工具的 `execute` 内部，在真正发起 I/O 之前将参数路径做 realpath 双侧规范化比对。两者的关键差异在于覆盖面：审批层看到所有工具调用（包括 MCP 与子代理工具，未分类者默认 ask），而路径守卫只存在于七个内置工具的实现体内。

```mermaid
flowchart TD
    A["模型发出 toolCall"] --> B["TypeBox schema 校验<br/>(Pi agent-core)"]
    B --> C{"beforeToolCall 权限闸门<br/>runtime.ts L44"}
    C -->|"deny"| X["阻断 + 理由回传模型"]
    C -->|"allow"| D["tool.execute()"]
    D --> E{"内置路径型工具?<br/>(read/write/edit/grep/find/ls)"}
    E -->|"是"| F["resolveWorkspacePath<br/>realpath 双侧校验"]
    F -->|"越界"| Y["PathOutsideProjectError"]
    F -->|"通过"| G["实际 I/O"]
    E -->|"bash"| H["仅 cwd 参数过守卫<br/>command 串直达 spawn"]
    H --> G
    E -->|"MCP / 子代理工具"| I["无路径守卫<br/>仅靠审批层默认 ASK"]
    I --> G

    style C fill:#f9f,stroke:#333
    style F fill:#bbf,stroke:#333
    style H fill:#fbb,stroke:#333
    style I fill:#fbb,stroke:#333
```

图中红色区域标出了两道机制都不设防的位置——这正是"并非沙箱"声明的具体所指。对比两道机制的属性：

| 维度 | 审批层（PermissionManager） | 路径守卫（resolveWorkspacePath） |
|---|---|---|
| 执行时机 | 工具执行前，`beforeToolCall` 钩子 | 工具 `execute` 内部，I/O 发起前 |
| 覆盖工具 | 全部工具；未分类工具默认 ASK | 仅 7 个内置路径型工具的路径参数 |
| 判定依据 | 正则规则 + 启发式分类器 + 记忆模式 + 用户决策 | `fs.realpathSync` 规范化后的位置比对 |
| 能拦截什么 | 未获批准的危险操作、灾难性命令 | 经由路径参数逃出项目根的一切访问（含符号链接） |
| 不能拦截什么 | 已被分类为 safe 的命令的真实副作用 | 不以路径参数形式出现的副作用（如 bash 命令串） |
| 失效模式 | 启发式漏判后依赖人类审阅 | 只约束显式传入的路径字符串 |

Sources: [runtime.ts](src/agent/runtime.ts#L44-L53)、[manager.ts](src/permissions/manager.ts#L82-L123)、[rules.ts](src/permissions/rules.ts#L64-L110)、[paths.ts](src/tools/paths.ts#L51-L88)

## 路径守卫的精确边界：它保护谁，保护不了谁

守卫的正面清单可以从 `resolveWorkspacePath` 的全部调用点读出：`read`、`edit`、`write`、`grep`、`find`、`ls` 六个工具的目标路径，加上 `bash` 工具的工作目录参数——恰好七个调用点，每个内置路径型工具一次。测试用真实的符号链接固化了这条边界：指向外部密钥文件的链接读取被拒、经符号链接目录写入被拒、悬空链接在写入前被显式拒绝（因为创建会跟随链接落到工作区外）、甚至项目根本身经由符号链接进入时规范化依然正确而穿越性逃逸仍被抓捕。

但边界的另一侧同样精确。`bash` 工具只有 `cwd` 参数经过守卫校验，**命令字符串本身完全不经过任何路径检查**——`cat /etc/passwd` 或 `echo x > ~/notes` 在路径层面是合法输入，唯一的裁决者是审批层。更进一步，[bash.ts](src/tools/bash.ts#L83-L87) 以 `spawn("bash", ["-c", command], { env: process.env })` 启动子进程：没有 chroot、没有 namespace、没有环境变量裁剪，子进程拿到的是与你手工开终端时完全相同的能力与凭据。第三个缺口在 MCP：适配器的外部工具 `execute` 直接透传 `callTool` 到远端进程，路径守卫对其不存在，唯一约束是规则层"unclassified tool 默认 ASK"这一条兜底。

| 工具/通道 | 经过路径守卫？ | 经过审批层？ | 备注 |
|---|---|---|---|
| `read` / `grep` / `find` / `ls` | ✅ 目标路径 | ✅ 项目内只读自动放行 | 越界读取降级为 ASK |
| `write` / `edit` | ✅ 目标路径 + 祖先链 | ✅ 一律 ASK | 项目内修改也需批准 |
| `bash` 的 `cwd` 参数 | ✅ | ✅ 越界 ASK | 仅约束初始目录 |
| `bash` 的 `command` 字符串 | ❌ | ✅ 分类器路由 | **主要逃逸面** |
| MCP 外部工具 | ❌ | ✅ 默认 ASK | 远端进程行为不受本地守卫感知 |
| 子代理工具 | 部分（worker 只载入只读工具子集） | ✅ | 并发上限 3，见子代理监督章节 |

Sources: [workspace-boundary.test.ts](tests/workspace-boundary.test.ts#L51-L121)、[bash.ts](src/tools/bash.ts#L75-L87)、[mcp/adapter.ts](src/mcp/adapter.ts#L43-L45)、[rules.ts](src/permissions/rules.ts#L108-L109)

## 审批层的真实强度：硬拒绝是地板而非围墙

审批层最坚硬的部分是**硬拒绝规则**，但其设计哲学恰恰揭示了整道防线的定位。[rules.ts](src/permissions/rules.ts#L44-L48) 的注释直言这份清单"Deliberately tiny: only commands whose damage is unrecoverable"——只有五条正则，覆盖文件系统根递归强删、家目录删除、格式化文件系统、裸盘写入与全局 chmod 777。测试证明了它的不可逾越性：auto 模式不能绕过、记忆的"always allow"模式不能绕过、甚至用户亲手点击批准也不能绕过——提示回调根本不会被触发。这是整个系统中唯一无条件生效的安全保证。

在这块地板之上，一切其余裁决都是概率性的。分类器按动词正则将命令分为 safe/write/destructive 三级，未知动词保守地判为 write、管道入 shell 在整行级别捕获为 destructive，但这些终究是启发式：正则可以被变形绕过，语义等价的危险命令可能落在白名单之外。设计者的应对不是加强正则，而是把裁决权交还给人类——destructive 与 write 级别一律走 ASK，最终由对话框里的人做决定。这也解释了为什么无头模式的默认语义如此保守：`-p` 没有对话框，所有 ASK 级操作直接拒绝，自动化必须通过 `--permission-mode auto` 显式换血——本质上是用户签署了一份"我接受除五条硬拒绝外全部放行"的知情同意书。

| 尝试绕过硬拒绝的方式 | 结果 | 证据 |
|---|---|---|
| `--permission-mode auto` | ❌ 仍拒绝，reason 含 "catastrophic" | 单元级 + E2E 双重验证 |
| 会话中已记忆的 always-allow 模式 | ❌ 仍拒绝，提示函数未被调用 | `prompted === false` 断言 |
| 用户在对话框中选择批准 | ❌ 对话框根本不会弹出 | 硬拒绝在 check 入口短路返回 |
| 提示回调抛出异常 | 安全退化为 deny | 异常被捕获转为拒绝理由 |

Sources: [rules.ts](src/permissions/rules.ts#L44-L62)、[permission-hardening.test.ts](tests/permission-hardening.test.ts#L35-L71)、[classifier.ts](src/permissions/classifier.ts#L77-L105)

## 威胁模型对照：直觉假设 vs 实际保障

把声明翻译成一张对照表，可以暴露最常见的误读。其中最锋利的一条来自代码本身的事实链：分类器的 SAFE_VERBS 白名单包含 `env` 与 `printenv`（[classifier.ts](src/permissions/classifier.ts#L53-L54)），safe 级命令在规则层直接放行（[rules.ts](src/permissions/rules.ts#L97-L100)），而 bash 子进程完整继承 `process.env`（[bash.ts](src/tools/bash.ts#L83-L87)）——三条事实串联意味着一条 `printenv <API_KEY>` 命令可以在 auto 模式下不经任何人工批准打印出你的模型凭据。这不是推测，是从三处源码可直接推导的行为；它以最具体的方式演示了"审批层不是沙箱"的含义。

| 直觉假设 | 实际保障 | 边界条件 |
|---|---|---|
| 智能体读不到项目外的文件 | 文件工具层面成立：realpath 双侧校验拦截符号链接逃逸 | bash 的 `cat`/`head` 可读任意用户可读文件（需过审批） |
| 智能体写不出项目目录 | 同上，新建文件还要求祖先链全部存在于工作区内 | bash 重定向与写类命令不受守卫约束 |
| 危险命令一定被拦下 | 仅五类不可恢复损伤被无条件硬拒绝 | 其余依赖启发式分类 + 人类在对话框中否决 |
| 无头模式天然安全 | ASK 级默认拒绝，方向正确 | `--permission-mode auto` 一键放弃这层保护 |
| API 密钥不会流向模型/进程 | 配置文件中的密钥字段触发启动告警；`.gitignore` 排除密钥文件 | bash 子进程继承完整环境变量且 `printenv` 属 safe 级 |
| MCP 工具受同样的路径纪律约束 | 否——守卫只在内置工具实现体内 | 外部服务器进程的行为对本地代码不可见 |

Sources: [classifier.ts](src/permissions/classifier.ts#L52-L59)、[rules.ts](src/permissions/rules.ts#L96-L105)、[bash.ts](src/tools/bash.ts#L83-L87)、[README.md](README.md#L156-L168)

## 纵深防御的真实剖面与运行守则

把全部证据叠成一张防御剖面图，可以看到应用内策略与操作系统边界之间的断层：

```mermaid
flowchart TB
    subgraph APP["TinyCode 进程内（应用态策略）"]
        direction TB
        L1["① Schema 校验<br/>参数形状合法性"]
        L2["② 权限闸门<br/>硬拒绝 → 规则 → 记忆/auto/对话框"]
        L3["③ 路径守卫<br/>realpath 双侧规范化（仅内置工具）"]
    end
    subgraph GAP["⚠ 断层：无进程级隔离"]
        G1["同一用户身份 · 继承完整 process.env<br/>spawn 无 chroot/namespace/seccomp"]
    end
    subgraph KERNEL["操作系统内核（未被利用的隔离原语）"]
        K1["文件权限 · 用户配额 · 容器/VM（需外部提供）"]
    end
    APP --> GAP --> KERNEL
```

据此得出与 README 完全一致的运行守则：**TinyCode 适合在你自己拥有并信任的项目目录里充当受监督的编码协作者——审批对话框就是人机契约的履约现场**；而运行真正不可信的代码或任务时，必须由外部提供隔离边界（容器、虚拟机），TinyCode 自身不替代它们。配套的卫生习惯同样写在 Security notes 中：API 密钥只放环境变量，`.tinycode/*.local.json` 等密钥形态文件已被 `.gitignore` 覆盖，配置文件中出现疑似密钥的字段会在启动时收到醒目警告。一句话收束本页：这套系统保证的是"**没有你的知情同意，危险操作不应发生**"，而不是"即使智能体失控也造不成破坏"——后者属于沙箱的职责，前者才是审批层的承诺。

Sources: [README.md](README.md#L156-L168)、[ARCHITECTURE.md](ARCHITECTURE.md#L114-L139)

## 下一步阅读

本页是权限与安全章节的收官综述，各机制的实现细节分布在相邻页面：路径守卫的算法与符号链接攻防见 [工作区路径守卫：符号链接感知的双侧 realpath 校验](12-gong-zuo-qu-lu-jing-shou-wei-fu-hao-lian-jie-gan-zhi-de-shuang-ce-realpath-xiao-yan)；三级风险分类的正则清单见 [Shell 风险分类器：safe、write 与 destructive 三级判定](13-shell-feng-xian-fen-lei-qi-safe-write-yu-destructive-san-ji-pan-ding)；裁决顺序的完整推演见 [权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)；两种交互面的差异语义见 [审批交互面：TUI 对话框与无头模式的差异化语义](15-shen-pi-jiao-hu-mian-tui-dui-hua-kuang-yu-wu-tou-mo-shi-de-chai-yi-hua-yu-yi)。若关注不受守卫约束的两个外部通道，参见 [MCP 集成：stdio 服务器并行连接与单点故障隔离](22-mcp-ji-cheng-stdio-fu-wu-qi-bing-xing-lian-jie-yu-dan-dian-gu-zhang-ge-chi) 与 [子代理监督：只读工作线程、并发上限与结构化报告回收](23-zi-dai-li-jian-du-zhi-du-gong-zuo-xian-cheng-bing-fa-shang-xian-yu-jie-gou-hua-bao-gao-hui-shou)；七个内置工具的完整行为契约见 [七大内置工具详解：read/edit/bash 等的行为契约](10-qi-da-nei-zhi-gong-ju-xiang-jie-read-edit-bash-deng-de-xing-wei-qi-yue)。