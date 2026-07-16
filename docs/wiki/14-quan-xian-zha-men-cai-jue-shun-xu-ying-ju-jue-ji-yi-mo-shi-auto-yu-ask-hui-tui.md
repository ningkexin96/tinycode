任何一次工具调用在真正执行之前，都要穿过一道统一的权限闸门——`PermissionManager.check()`。这个方法虽然只有四十余行，却编码了 TinyCode 整个安全策略的优先级次序：静态规则先于一切交互，硬拒绝先于一切放行路径，记忆模式先于模式开关，模式开关先于人工弹窗，而弹窗缺席时宁可拒绝也不崩溃。本页解剖这条裁决链的每一层，说明为什么"rm -rf /"在任何配置下都绝无生还可能，而"npm install foo"的命运则取决于记忆、模式与人三者的先后发言权。

## 裁决流水线总览

理解裁决顺序的关键前提是：`check()` 内部并非一串并列的 if，而是一条**短路流水线**——上游一旦给出终局结论，下游所有环节立即失活。流水线的第一站是纯函数式的静态规则求值器 `evaluateRules()`，它不产生任何副作用，仅依据工具名、输入与项目根路径输出 `allow` / `ask` / `deny` 三种裁决。只有 `ask` 裁决才会继续流入第二站：会话级记忆匹配、模式开关、以及最终的提示回调。

```mermaid
flowchart TD
    A["工具调用<br/>check(toolName, input)"] --> B["evaluateRules()<br/>静态规则求值"]
    B -->|"deny<br/>灾难性命令"| C["❌ 硬拒绝<br/>后续全部短路"]
    B -->|"allow<br/>项目内只读等"| D["✅ 放行"]
    B -->|"ask"| E{"记忆模式匹配?<br/>toolName + 标题前缀"}
    E -->|"命中"| F["✅ 放行<br/>allowed by remembered pattern"]
    E -->|"未命中"| G{"mode === 'auto'?"}
    G -->|"是"| H["✅ 放行<br/>auto-approved"]
    G -->|"否"| I{"prompt 回调存在?"}
    I -->|"否"| J["❌ 安全失败拒绝<br/>no permission prompt available"]
    I -->|"是"| K["弹出审批对话"]
    K -->|once| L["✅ 仅本次放行"]
    K -->|always| M["记住模式族 + ✅ 放行"]
    K -->|deny / 异常| N["❌ 拒绝"]
```

这张图中的每条边都对应 `check()` 方法里一段可验证的控制流，且顺序不可交换——后文将逐层展开"为什么是这个顺序"。

Sources: [manager.ts](src/permissions/manager.ts#L82-L123)

## 第一站：静态规则的三值裁决

`evaluateRules()` 是整条链上唯一能产出 `deny` 的地方，也是绝大多数 `allow` 的来源。它的判定逻辑按工具类别分流：只读工具（`read`、`grep`、`find`、`ls`）在项目内直接 `allow`，越出项目边界则降为 `ask`；写类工具（`write`、`edit`）无论目标在哪一律 `ask`——即便写在项目内也不会静默放行，这是刻意的保守设计；bash 工具最复杂，依次经过硬拒绝正则清单、工作目录边界校验、最后交给风险分类器给出 safe/write/destructive 三档结论；所有后续注册的工具（MCP、子代理、技能）因无法静态分类，统一默认 `ask`。

值得强调的是路径解析的细节：`resolveToolPath()` 会做波浪号展开与规范化后再计算相对位置，因此 `src/../src/a.ts` 这样的绕行写法也会被正确判定为项目内，而 `/etc/hosts` 或 `../sibling` 则被识别为越界。这意味着静态规则的边界判断建立在**归一化后的绝对路径**上，而非原始字符串比对。

Sources: [rules.ts](src/permissions/rules.ts#L64-L110), [rules.ts](src/permissions/rules.ts#L26-L40), [tests/permissions.test.ts](tests/permissions.test.ts#L48-L74)

## 第二站：硬拒绝为何不可协商

`HARD_DENY_BASH` 清单刻意保持极小——源码注释直言其收录标准是"损害不可恢复"（damage unrecoverable）的命令：递归强删文件系统根、删除家目录、格式化文件系统、对物理磁盘设备的裸写、以及对根目录的递归 777 授权。这五条正则在 `evaluateRules()` 的 bash 分支中最先求值，命中即返回 `deny`，理由形如 `"catastrophic command refused: format filesystem"`。

裁决顺序在此体现出它的安全意义：`check()` 收到 `deny` 后立即返回，**根本不会构造标题、不会查询记忆模式、不会检查 auto 开关、更不会弹出对话框**。加固回归测试用一个精巧的用例固化了这一点——预先调用 `rememberAlways("bash", "rm -rf")` 记忆一个恶意前缀，再请求执行 `rm -rf /`，断言结果是拒绝且 `prompted === false`：不仅硬拒绝生效，连弹窗的机会都不曾出现。同理，即使以 `mode: "auto"` 构造管理器，灾难性命令依然被拒。换言之，auto 模式、记忆模式、用户审批这三个"放行通道"在架构上都位于硬拒绝的下游，物理上无法触达它。

Sources: [rules.ts](src/permissions/rules.ts#L44-L62), [manager.ts](src/permissions/manager.ts#L84-L87), [permission-hardening.test.ts](tests/permission-hardening.test.ts#L35-L72)

## 第三站：会话级记忆模式的词边界匹配

当静态规则给出 `ask` 后，闸门首先咨询的不是人，而是**本次会话内积累的批准记忆**。每个记忆项是一个二元组 `{toolName, titlePrefix}`：`rememberAlways()` 会将前缀修剪并转为小写存储，匹配时同样将当前请求标题规范化，然后要求两者相等、或以"前缀 + 空格"开头。这个词边界约束至关重要——记忆了 `npm install` 之后，`npm install left-pad` 会命中，但 `npm installx` 不会，避免了前缀匹配的经典误配陷阱。

记忆项本身从何而来？当用户在弹窗中选择 "always" 时，系统不是原样记录整条命令，而是通过 `derivePatternPrefix()` 将请求**归约为一个批准家族**：bash 命令取前两个词（`npm install foo` → `npm install`），其他工具取工具名加首个参数（`write src/a.ts` → `write src`）。源码注释点明意图：记住的是命令家族而非单次精确调用，这样相似的未来请求才能跳过对话框。这也解释了测试中观察到的行为序列——第一次 `npm install foo` 弹窗，用户选 always 后，第二次 `npm install bar` 就直接以 `allowed by remembered pattern` 放行，弹窗计数不再增长。

Sources: [manager.ts](src/permissions/manager.ts#L37-L80), [manager.ts](src/permissions/manager.ts#L113-L118), [manager.ts](src/permissions/manager.ts#L142-L147), [tests/permissions.test.ts](tests/permissions.test.ts#L84-L115)

## 第四站：auto 模式与 ASK 回退的安全失败

记忆未命中时，裁决权移交给模式开关。`auto` 模式下所有 `ask` 裁决自动放行，理由字符串保留上游规则的原因作为审计线索：`auto-approved (${verdict.reason})`。该模式的存在场景被注释明确定为测试与 CI（经由 `TINYCODE_PERMISSION_MODE=auto`），配置加载器只接受字面量 `ask` 或 `auto` 作为环境变量值，其余值被静默忽略而不污染配置。

`ask` 模式下的行为则取决于宿主是否注入了提示回调，这里藏着整个设计中最重要的一条防御性决策：**回调缺失时拒绝而非崩溃**。一次性无头模式正是依赖这一语义——`runPrintMode` 强制 `permissionMode ?? "ask"` 且从不注入 prompt 回调，于是所有 `ask` 裁决统一落地为 `no permission prompt available: ...` 的拒绝，模型收到工具错误但进程安然完成。E2E 加固测试验证了完整的因果链：无头模式下 `npm install left-pad` 被拒且工作区中确实没有产生 node_modules 目录；而显式传入 `--permission-mode auto` 可恢复自动化；同时 `mkfs.ext4 /dev/sda` 即使在显式 auto 下端到端仍被拒绝。即便回调存在，其执行若抛出异常也被捕获并转化为 `permission prompt failed` 拒绝——任何一条通往执行的路径都要求明确的肯定答复。

Sources: [manager.ts](src/permissions/manager.ts#L95-L112), [loader.ts](src/config/loader.ts#L102-L105), [cli/index.ts](src/cli/index.ts#L96-L116), [permission-hardening.test.ts](tests/permission-hardening.test.ts#L74-L154)

## 与代理循环的集成：block 语义

闸门并非由工具实现自行调用，而是挂载在 Pi 代理循环的 `beforeToolCall` 钩子上，成为每次工具调用的必经之路。钩子将 `check()` 的结果翻译为循环协议：`allow` 返回 `undefined`（放行），`deny` 返回 `{ block: true, reason }`，其中拒绝理由以 `Permission denied:` 为前缀注入。这个设计有两个值得注意的后果：其一，权限层对工具完全透明，新增工具无需感知审批逻辑；其二，拒绝以**结构化的工具错误消息**回流给模型而非中断进程，模型可以据此调整策略（例如改用只读命令），这正是加固测试中断言 `isError === true` 且错误内容包含拒绝原因的机制基础。模式切换同样是运行时可变的——`setMode()` 允许宿主在会话中途热切换，状态栏则实时展示当前模式与已记忆的模式数量。

Sources: [runtime.ts](src/agent/runtime.ts#L44-L53), [manager.ts](src/permissions/manager.ts#L49-L59), [slash.ts](src/tui/slash.ts#L141-L148)

## 五类裁决出口对照

下表汇总了 `check()` 所有可能的出口及其触发条件与理由文案，可作为调试权限问题时的速查表：

| 出口 | 触发条件 | 理由文案 | 能否被 auto 覆盖 |
|------|---------|---------|----------------|
| 放行（规则） | 项目内只读工具 / safe 命令 | `read-only inside project` 等 | 不适用（未到达模式层） |
| 硬拒绝 | 命中 `HARD_DENY_BASH` 五条正则 | `catastrophic command refused: <label>` | ❌ 绝不 |
| 放行（记忆） | ask 裁决 + 词边界前缀命中 | `allowed by remembered pattern` | 不适用 |
| 放行（自动） | ask 裁决 + `mode === "auto"` | `auto-approved (<rule reason>)` | — |
| 放行（一次） | 弹窗选 Allow once | `allowed once` | — |
| 放行（总是） | 弹窗选 Always | `allowed always (remembered)` | — |
| 拒绝（用户） | 弹窗选 Deny 或 ESC | `denied by user` | — |
| 拒绝（无回调） | ask 模式 + prompt 未注入 | `no permission prompt available: ...` | 否（auto 已提前拦截此分支） |
| 拒绝（回调异常） | prompt 函数抛错 | `permission prompt failed: <message>` | — |

这张表揭示了一个不对称性：九种出口中五种是放行、四种是拒绝，但**所有放行都要求至少一个明确的肯定信号**（规则白名单、历史记忆、显式 opt-in 或人工选择），而拒绝既可以是主动否定，也可以是任何基础设施缺位时的兜底。这种"默认关闭"的姿态贯穿始终。

Sources: [manager.ts](src/permissions/manager.ts#L27-L29), [manager.ts](src/permissions/manager.ts#L82-L123)

## 设计要点回顾

回到开头的命题，这条裁决链的价值不在单个环节而在**顺序本身**：硬拒绝置于最上游使其免疫于一切下游配置；记忆模式置于模式开关之前意味着用户的历史选择比全局自动化更具特异性话语权；auto 置于弹窗之前使 CI 场景无需伪造交互；而无回调时的安全失败保证了任何宿主集成的疏漏都以拒绝而非事故收场。五层之间没有一处允许"跳过中间层"的捷径——这是典型的纵深防御排序，每一层只为上一层未决的问题提供答案。

想继续深入这条链的两端，可阅读上游的风险分类器如何给 bash 命令定级：[Shell 风险分类器：safe、write 与 destructive 三级判定](13-shell-feng-xian-fen-lei-qi-safe-write-yu-destructive-san-ji-pan-ding)；或下游的审批界面如何呈现 once/always/deny 三个选项：[审批交互面：TUI 对话框与无头模式的差异化语义](15-shen-pi-jiao-hu-mian-tui-dui-hua-kuang-yu-wu-tou-mo-shi-de-chai-yi-hua-yu-yi)。若关心这套审批层的整体安全边界声明（它不是操作系统沙箱），参见[安全模型声明：审批层加路径守卫并非操作系统沙箱](16-an-quan-mo-xing-sheng-ming-shen-pi-ceng-jia-lu-jing-shou-wei-bing-fei-cao-zuo-xi-tong-sha-xiang)。