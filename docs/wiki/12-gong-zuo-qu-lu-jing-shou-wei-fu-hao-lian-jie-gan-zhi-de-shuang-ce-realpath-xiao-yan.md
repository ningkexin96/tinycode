TinyCode 的七个内置工具都承诺"只在项目目录内活动"，但这个承诺的真正兑现者不是工具本身，而是一个约一百行的路径守卫模块 `src/tools/paths.ts`。本页剖析它如何弥补纯词法路径校验被符号链接击穿的缺陷——核心思路是把比较的**两侧**（用户提供的路径、项目根目录）都规范化到真实磁盘位置后再判定，并对"已存在 / 悬空链接 / 尚不存在"三种目标状态分别处理。文中还会覆盖各工具的接入方式、遍历层的纵深防御，以及它与权限闸门之间的职责分工。

Sources: [paths.ts](src/tools/paths.ts#L1-L102)

## 威胁模型：词法校验为何会被符号链接击穿

判断一个路径是否在项目内，最直觉的做法是 `path.resolve` 转绝对路径后用 `path.relative` 看相对结果是否以 `..` 开头。这套纯字符串运算对 `../outside.txt` 这类显式越界有效，但对符号链接完全失明：项目里一个 `outside-link -> /tmp/secret.txt` 的链接，其词法形态 `outside-link` 完美落在项目内，实际读取却发生在文件系统另一端。

`paths.ts` 的模块注释直接点明了这一盲区，并给出对策概要："词法检查无法看穿符号链接……本守卫在比较前将两侧都规范化"。这正是页面标题中"双侧 realpath 校验"的含义——不是校验两次，而是比较关系式 `target ∈ root` 的两边各自取真身再比较。

Sources: [paths.ts](src/tools/paths.ts#L5-L18)

## 核心算法：`resolveWorkspacePath` 的完整决策流

守卫入口 `resolveWorkspacePath(projectRoot, raw)` 返回一个"可安全交给 `node:fs` 使用"的词法绝对路径。它的流水线分四步：先经 `resolveToolPath` 完成 `~` 展开与词法拼接得到 `absolute`；随即对项目根取 `fs.realpathSync` 得到根侧真身 `realRoot`；然后对 `absolute` 本身做三分支判定；任一分支通过后返回的仍是 `absolute`（而非真身），保证后续 I/O 与错误信息中的路径形态一致。

```mermaid
flowchart TD
    A["模型提供的原始路径 raw"] --> B["resolveToolPath<br/>~ 展开 · 拼接项目根 · 词法规范化"]
    B --> C["absolute 词法绝对路径"]
    C --> D["fs.realpathSync(projectRoot)<br/>根侧规范化 realRoot"]
    D --> E{"fs.realpathSync(absolute)<br/>能否解析？"}
    E -->|"成功：目标已存在"| F{"realTarget 在 realRoot 内？"}
    F -->|是| G["返回 absolute ✓"]
    F -->|否| H["抛出 PathOutsideProjectError ✗"]
    E -->|"失败：目标尚不存在"| I{"lstat 显示为符号链接？"}
    I -->|"是：悬空链接"| J["显式拒绝<br/>broken symlink ✗"]
    I -->|"否：真正不存在"| K["nearestExistingReal<br/>向上回溯最近存在祖先取 realpath"]
    K --> L{"祖先真身在 realRoot 内？"}
    L -->|是| G
    L -->|否| H
```

Sources: [paths.ts](src/tools/paths.ts#L45-L64)，[rules.ts](src/permissions/rules.ts#L26-L40)

### 为什么根侧也要规范化

只把目标路径取真身还不够。若整个项目根本身就是通过符号链接触达的——例如工具以 `/tmp/link -> 实际项目根` 为根启动——用原始根路径去约束已规范化的目标会误杀一切合法调用。测试 `"a symlinked project root itself canonicalizes correctly"` 精确覆盖了这个场景：以链接为根时读取 `src/a.ts` 正常工作，而借同一根内的 `out-dir` 外逃仍被捕获。两侧同取 realpath 后，这类"根即链接"的部署形态自然正确。

Sources: [tests/workspace-boundary.test.ts](tests/workspace-boundary.test.ts#L105-L121)，[paths.ts](src/tools/paths.ts#L53)

## 目标侧三分支：已存在、悬空链接与尚未创建

目标路径在磁盘上的状态决定了走哪条校验路径，三条分支的安全语义各不相同：

| 分支 | 判定手段 | 通过条件 | 拒绝时的语义 |
|---|---|---|---|
| 目标已存在 | `fs.realpathSync(absolute)` 成功 | 真身落在 `realRoot` 内 | 链接指向外部（读/写/编辑均拦截） |
| 悬空符号链接 | realpath 失败后 `lstatSync` 显示 `isSymbolicLink()` | 不允许通过 | 显式报错，防止写入时"顺着链接创建"到外处 |
| 尚不存在的路径 | realpath 失败且 lstat 也无此条目 | 最近存在祖先的真身在 `realRoot` 内 | 祖先链上有外指链接则拒绝 |

第三分支是写类工具的安全基石。`write` 工具在守卫通过后会 `mkdirSync(dirname, { recursive: true })` 自动创建父目录——若不做祖先校验，攻击者可以请求 `out-dir/x.txt`（`out-dir` 是指向外部的目录链接），守卫放行一个"尚不存在"的路径，随后的递归建目录就在工作区外落盘。代码注释对此有明确推理："每个已存在的组件都必须解析进规范化的项目根，新文件才只可能诞生于这些组件之下"。

悬空链接分支同样来自真实的攻击面：`dangling-link -> /tmp/outside/does-not-exist.txt` 词法上"不存在"，若按普通新文件放行，write 创建内容时会跟随链接在外部生成文件。守卫对这种情况单独抛出带 `broken symlink target does not exist` 说明的错误，而非笼统的越界信息。

Sources: [paths.ts](src/tools/paths.ts#L67-L87)，[paths.ts](src/tools/paths.ts#L45-L50)，[write.ts](src/tools/write.ts#L41-L42)

## 最近存在祖先回溯：`nearestExistingReal`

对"路径尚不存在"的情况，守卫需要找到该路径下第一个**真实存在**的组件来代表它的磁盘位置。`nearestExistingReal` 用一个无上限循环实现：对当前路径尝试 `realpathSync`，成功则连同"剩余未存在部分"（`suffix`）一起返回；失败则上跳 `dirname` 重试，直至抵达文件系统顶端仍失败时抛出 `Unresolvable path` 兜底错误。

这个设计的巧妙之处在于它天然免疫中间层链接：无论链接藏在路径的第几层（`a/link-to-outside/b/c/new.txt`），回溯总会停在第一个真实存在的组件上——也就是那个链接自身——其真身必然暴露外指事实，从而被 `isInside` 拦截。

Sources: [paths.ts](src/tools/paths.ts#L31-L43)

## 内部比较器与两个展示函数

判定的数学核心只有四行：`isInside` 计算 `path.relative(root, target)`，相对结果为空串（同一路径）、或不以 `..` 开头且非绝对路径（严格子路径）即为内部。所有越界拒绝统一抛出自定义的 `PathOutsideProjectError`，错误消息内嵌面向用户的显示路径。

配套的两个展示函数服务于模型交互闭环：`displayRaw` 把守卫拒绝时的原始输入转成规范的项目相对形式放进错误文本，让模型看到自己到底请求了什么；`displayPath` 则在每个工具的成功输出里把绝对路径折算回相对形式，提示模型后续调用应使用这种形态。二者共享同一段"空串折叠为 `.`、分隔符统一为 `/`"的逻辑。

Sources: [paths.ts](src/tools/paths.ts#L26-L29)，[paths.ts](src/tools/paths.ts#L19-L24)，[paths.ts](src/tools/paths.ts#L90-L101)

## 七个工具的接入面

守卫不是某个工具的私有逻辑，而是全部内置工具的强制前置步骤。接入点高度一致——在 `execute` 的第一行完成路径解析，之后所有 I/O 只使用解析结果：

| 工具 | 接入位置 | 校验对象 | 越界后果 |
|---|---|---|---|
| `read` | 参数 `path` | 待读文件 | 抛 `PathOutsideProjectError` |
| `write` | 参数 `path` | 目标文件（含新建场景的祖先链） | 同上 |
| `edit` | 参数 `path` | 待编辑文件 | 同上 |
| `ls` | 参数 `path`（默认 `.`） | 列举目录 | 同上 |
| `grep` | 搜索根 `path`（默认 `.`） | 搜索起点 | 同上 |
| `find` | 搜索根 `path`（默认 `.`） | 搜索起点 | 同上 |
| `bash` | 参数 `cwd`（默认 `.`） | 子进程工作目录 | 同上，随后以该目录 `spawn` |

bash 工具的接入值得单独一提：它校验的不是命令要碰的文件（那无法枚举），而是进程启动目录 `cwd`，守卫通过后才把该目录交给 `spawn("bash", ["-c", command])`。这保证了至少"进程视角的原点"不会落在项目之外，命令本体则交由权限层裁决——下一节展开这个分工。

Sources: [read.ts](src/tools/read.ts#L44)，[write.ts](src/tools/write.ts#L33)，[edit.ts](src/tools/edit.ts#L43)，[ls.ts](src/tools/ls.ts#L38)，[grep.ts](src/tools/grep.ts#L53)，[find.ts](src/tools/find.ts#L31)，[bash.ts](src/tools/bash.ts#L76)

## 纵深防御：目录遍历层从不跟随符号链接

即便搜索根本身通过了守卫，`grep` 和 `find` 递归下探时仍可能在深层遇到符号链接。第二道防线位于共用的遍历器 `walkFiles`：它用 `readdir(dir, { withFileTypes: true })` 获取 Dirent 条目，而 Dirent 反映的是条目自身的类型——指向目录的符号链接其 `isDirectory()` 为 false，指向文件的符号链接其 `isFile()` 也为 false。于是第 33–39 行的过滤逻辑使符号链接既不会进入遍历队列、也不会作为文件产出，模块注释一句话概括："symlinks are not followed"。

两层防线的关系可以这样理解：守卫负责"入口"（搜索根不能是外指链接），遍历器负责"途中"（下探过程不越过任何链接边界）。回归测试里 `ls/grep/find refuse symlinked directories as search roots` 直接断言了对链接目录作搜索根会抛出 `PathOutsideProjectError`，对应入口侧防线。

```mermaid
flowchart LR
    M["模型工具调用"] --> P["权限闸门 beforeToolCall<br/>evaluateRules · 词法快筛"]
    P -->|"allow 或 ask 获批"| T["工具 execute<br/>七工具统一首行接入"]
    T --> G["resolveWorkspacePath<br/>双侧 realpath · 三分支判定"]
    G -->|"通过"| W["node:fs 真实 I/O<br/>遍历层不跟随链接"]
    G -->|"越界"| E["PathOutsideProjectError<br/>回传模型"]
```

Sources: [walk.ts](src/tools/walk.ts#L15-L18)，[walk.ts](src/tools/walk.ts#L28-L39)，[tests/workspace-boundary.test.ts](tests/workspace-boundary.test.ts#L78-L80)

## 与权限闸门的分工：词法快筛在先，真身校验在后

一次工具调用实际穿过两道独立的路径检查，且二者使用的坐标系不同。第一道在代理循环的 `beforeToolCall` 钩子里：权限管理器的规则引擎用 `resolveToolPath` 做**词法**判断——项目内的只读操作自动 `allow`，项目外的读写或 bash 的外部 `cwd` 升级为 `ask` 请求人工批准。第二道才是本页主角：获批后的工具执行体内运行 realpath 守卫。

这个分层产生了一个微妙但正确的组合效应：像 `read outside-link` 这样的调用在权限层看来是完全合法的项目内只读操作（词法上确实如此），会被静默自动批准；但进入工具执行后，realpath 守卫识破链接真身并将其拒绝。换句话说，权限层负责决定"要不要打扰用户"，守卫负责保证"批准的操作也逃不出工作区"——前者无法替代后者，因为审批发生在看到真实磁盘布局之前。

Sources: [runtime.ts](src/agent/runtime.ts#L44-L53)，[rules.ts](src/permissions/rules.ts#L69-L96)，[rules.ts](src/permissions/rules.ts#L26-L40)

## 回归测试矩阵：真实符号链接驱动的行为契约

`tests/workspace-boundary.test.ts` 是守卫的行为规格书。它不用 mock，而是在临时目录里创建真实的符号链接夹具（外指文件链接、外指目录链接、悬空链接各一），并用探测代码检测平台是否支持 symlink、不支持则整组跳过：

| 测试用例 | 攻击向量 | 断言 |
|---|---|---|
| read through a symlinked file | 经文件链接读取外部密文 | 拒绝且匹配越界错误 |
| edit through a symlinked file | 经文件链接改写外部文件 | 拒绝，且外部内容原封不动 |
| write into a symlinked directory | 向目录链接内写入新文件 | 拒绝，外部确无新文件落地 |
| broken symlink rejected on write | 经悬空链接诱骗创建 | 拒绝，链接目标处无文件 |
| ls/grep/find refuse linked search roots | 以外指目录为搜索根 | 直接抛 `PathOutsideProjectError` |
| normal workspace paths keep working | 合法读写编辑列举与 bash cwd | 全部正常（防误杀回归） |
| symlinked project root | 以链接为项目根 | 合法操作通行，外逃仍被拦 |

最后一列的两条"反方向"断言尤其关键：安全加固最常见的回归是误伤正常功能，因此用例 6 在同一个夹具上验证了常规读写、深路径新建（`src/new/deep.txt`）乃至 bash 在新建子目录里的 `cwd` 全部照常工作。

Sources: [tests/workspace-boundary.test.ts](tests/workspace-boundary.test.ts#L17-L49)，[tests/workspace-boundary.test.ts](tests/workspace-boundary.test.ts#L51-L103)

## 边界与定位声明：路径守卫而非操作系统沙箱

理解这个模块的能力上限与理解它的机制同等重要。源码注释自我定位明确："这是一个路径守卫，不是 OS 沙箱——bash 命令仍然能触及用户 shell 可及的任何东西，那些由权限层审批。"具体而言：守卫覆盖的是七个内置工具的**结构化参数路径**；bash 命令字符串内部的 `cat /etc/passwd` 不经过任何路径解析，只能靠[Shell 风险分类器](13-shell-feng-xian-fen-lei-qi-safe-write-yu-destructive-san-ji-pan-ding)的风险分级与审批兜底。此外守卫在解析时点生效，真正的 I/O 发生在其后，两次操作之间没有内核级的隔离保障。这些边界的完整讨论见[安全模型声明：审批层加路径守卫并非操作系统沙箱](16-an-quan-mo-xing-sheng-ming-shen-pi-ceng-jia-lu-jing-shou-wei-bing-fei-cao-zuo-xi-tong-sha-xiang)。

Sources: [paths.ts](src/tools/paths.ts#L16-L17)

## 延伸阅读

- 想了解守卫所保护的那七个工具各自的完整行为契约（截断策略、二进制检测、超时语义等），请继续阅读[七大内置工具详解：read/edit/bash 等的行为契约](10-qi-da-nei-zhi-gong-ju-xiang-jie-read-edit-bash-deng-de-xing-wei-qi-yue)。
- 本页提到的权限规则引擎（`evaluateRules` 的硬拒绝、allow/ask 判定次序）在[权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)中有逐分支拆解。
- bash 命令本身的危险等级如何划分为 safe/write/destructive 三级，见[Shell 风险分类器：safe、write 与 destructive 三级判定](13-shell-feng-xian-fen-lei-qi-safe-write-yu-destructive-san-ji-pan-ding)。