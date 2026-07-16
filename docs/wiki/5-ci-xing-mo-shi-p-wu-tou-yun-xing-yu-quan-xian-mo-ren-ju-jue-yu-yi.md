当你只想让编码智能体"执行一个任务、打印一个答案、然后退出"，而不想进入交互式终端界面时，`-p` 一次性模式就是为此设计的入口。本页面向初学者解释两件事：**无头运行**（headless，即没有 TUI 界面参与）的完整数据流，以及为什么在这种模式下权限请求会**默认拒绝**而不是崩溃或放行。读完你将理解一条精心设计的安全原则：*无人值守时，宁可拒绝，不可臆测*。

## 命令形态与参数解析

一次性模式的调用形式是 `tinycode -p "<prompt>"`。解析器在遇到 `-p` 或 `--print` 时，会把该选项的值以及其后所有剩余参数用空格拼接成完整的提示词——这意味着即使你忘了给提示词加引号，单词之间也不会丢失：

```bash
tinycode -p "explain this project"   # 标准写法
tinycode -p explain this project     # 宽松写法：三个词被 join 成一句
```

与之配套的是一条防呆规则：如果你直接输入了位置参数（比如 `tinycode hello world`）却没用 `-p`，程序不会猜测你的意图，而是报错并提示使用一次性模式的正确姿势。这个设计避免了"把普通文本误当成命令"的歧义。

Sources: [args.ts](src/cli/args.ts#L72-L91)

## 无头运行的数据流

从命令行到最终答案打印，整个流程不经过任何界面组件。下图展示了这条单向管道（阅读顺序自上而下）：

```mermaid
flowchart TD
    A["tinycode -p 'prompt'"] --> B["parseArgs 解析出 prompt"]
    B --> C{"prompt 存在？"}
    C -- 否 --> D["进入交互式 TUI"]
    C -- 是 --> E["runPrintMode"]
    E --> F["buildHarnessFromCli<br/>权限模式默认 ask"]
    F --> G["订阅 agent_end 事件"]
    G --> H["runtime.prompt(prompt)<br/>代理循环运行至完成"]
    H --> I["提取最后一条助手消息文本"]
    I --> J["stdout 打印答案后退出"]
```

前置说明：图中 `runPrintMode` 是 CLI 入口文件里的专用函数，它只做四件事——决定是否恢复会话、装配 harness、监听完成事件、打印结果。与 TUI 路径最大的区别在于：这里没有任何 `TuiApp` 的构造，也就没有人来回答权限对话框。

答案的提取逻辑值得注意：程序订阅代理事件流，在 `agent_end` 事件到达时从消息列表**倒序查找最后一条包含非空文本的助手消息**。如果模型全程只调用了工具而没有输出文字，你会看到兜底输出 `(no response)` 而不是空白。

Sources: [index.ts](src/cli/index.ts#L40-L43), [index.ts](src/cli/index.ts#L96-L133), [index.ts](src/cli/index.ts#L135-L147)

## 权限默认拒绝：缺失回调即安全失败

这是本页的核心语义。要理解它，先看权限管理器 `check()` 方法对每一类判定的处理路径：

| 判定来源 | 处理方式 | 无头模式下的实际结果 |
|---------|---------|-------------------|
| 静态规则判定 **deny** | 立即拒绝，任何后续环节都无法翻案 | 拒绝 |
| 静态规则判定 **allow** | 直接放行（如项目内只读操作） | 正常执行 |
| 判定 **ask** + 命中记忆模式 | 按"总是允许"的模式放行 | 放行 |
| 判定 **ask** + 显式 `auto` 模式 | 自动批准 | 放行 |
| 判定 **ask** + 有 prompt 回调 | 弹出对话框询问用户 | —（仅 TUI 存在此路径） |
| 判定 **ask** + **没有回调** | 返回 `{ deny }`，理由为 `no permission prompt available` | **默认拒绝** |

最后一行就是关键：在 `ask` 模式下，当管理器走到需要询问用户的分支却发现 `options.prompt` 未定义时，它不会抛异常、不会挂起等待，而是返回一个带明确理由的拒绝决定。源码注释将此概括为"a missing callback denies safely instead of crashing"。同样地，即使回调存在但执行时抛出了错误，也会被捕获并转化为拒绝——所有失败路径都收敛到"安全侧"。

Sources: [manager.ts](src/permissions/manager.ts#L3-L11), [manager.ts](src/permissions/manager.ts#L95-L123)

## 为什么无头模式下回调一定缺失？

默认拒绝不是巧合，而是装配结构的必然结果。整个代码库中**只有一个地方**注入 prompt 回调——交互式 TUI 启动时的这一行：

```ts
this.deps.permissions.setPrompt((request) => showPermissionDialog(this.tui, request));
```

而在 harness 引导阶段构造 `PermissionManager` 时，构造参数只有 `mode` 和 `projectRoot` 两项，根本没有 `prompt` 字段；CLI 层的一次性模式函数也从不调用 `setPrompt`。因此只要走 `-p` 路径，回调就必然是 `undefined`，上一节表格的最后一行必然生效。

用一句话总结这条因果链：**没有界面 → 没有人注册回答函数 → ASK 类请求无人应答 → 默认拒绝**。这也是 CLI 入口注释所强调的："ASK verdicts deny because there is no dialog — auto-approval requires an explicit opt-in."

Sources: [app.ts](src/tui/app.ts#L117), [bootstrap.ts](src/bootstrap.ts#L84-L87), [index.ts](src/cli/index.ts#L103-L116)

## 拒绝如何回传给模型

被拒绝的工具调用并不会让程序中断。运行时在代理循环上挂了一个 `beforeToolCall` 钩子，每次工具执行前都先过一遍权限检查；一旦收到 `deny` 决定，就返回 `{ block: true, reason: "Permission denied: ..." }`。Pi 代理循环会把这条拦截理由作为一次**失败的工具结果**写回对话流，于是模型能"看到"自己被拒绝了、知道原因是什么，进而调整策略——例如改用只读方式完成任务，或者在最终回答里向你说明哪些操作无法执行。

这种设计让无头运行的行为可预测：任务可能部分完成，但绝不会因为一次权限拒绝而整体崩掉。

Sources: [runtime.ts](src/agent/runtime.ts#L44-L53)

## 两条受控的例外通道

默认拒绝并不意味着无头模式只能做只读操作，仓库保留了两条需要你**主动选择**的通道：

**其一，显式启用自动批准。** 通过 `--permission-mode auto` 标志或 `TINYCODE_PERMISSION_MODE=auto` 环境变量，ASK 类操作会被自动放行，写文件、装依赖等自动化场景得以运转。但有一条底线无法突破：静态规则中的硬拒绝（如 `rm -rf /` 这类灾难性命令）在任何模式、任何回调、任何记忆模式之前就已生效，`auto` 对它无能为力。

**其二，显式恢复历史会话。** 一次性模式默认**不持久化**任何会话——运行结束即消失。只有当你传入 `--continue`（接最近一次会话）或 `--session <id>`（接指定会话）时才会落盘。引导代码只在有会话选项时才创建 `SessionManager`，否则该字段保持未定义，消息记录订阅自然不会建立。

Sources: [commands.ts](src/cli/commands.ts#L23-L31), [permission-hardening.test.ts](tests/permission-hardening.test.ts#L142-L153), [bootstrap.ts](src/bootstrap.ts#L105-L113), [index.ts](src/cli/index.ts#L103-L109)

## 测试如何锁定这些语义

仓库专门设有一组名为 "headless (-p style) permission semantics" 的回归测试，其文件头注释精确概括了三条不变量：`-p` 下 ASK 判定拒绝、`auto` 需显式选择才能恢复自动化、`auto` 永远绕不过硬拒绝。测试辅助函数 `bootPrintLike` 刻意复刻了一次性模式的真实装配方式——mock 模型加无回调的权限管理器，保证测试环境与生产路径同构：

| 测试场景 | 预期行为 |
|---------|---------|
| ask 模式下执行安全只读命令 | 正常执行，工具结果非错误 |
| ask 模式下执行 `npm install` | 工具结果为错误，内容匹配 `Permission denied` 或 `no permission prompt`，且工作区未被污染 |
| ask 模式下执行删除命令 | 同样被拒绝 |
| auto 模式下编辑文件 | 正常写入，证明显式选择有效 |
| auto 模式下执行灾难性命令 | 仍被拒绝，理由含 `catastrophic` |

端到端层面另有一条冒烟测试直接以子进程方式运行 `tinycode -p "describe this project"` 并断言 mock 模型的标志性输出出现，验证从 argv 到 stdout 的全链路。

Sources: [permission-hardening.test.ts](tests/permission-hardening.test.ts#L10-L33), [permission-hardening.test.ts](tests/permission-hardening.test.ts#L84-L126), [cli.test.ts](tests/cli.test.ts#L163-L166)

## 初学者速查与故障排查

| 现象 | 原因 | 解决方式 |
|------|------|---------|
| 输出 `(no response)` | 模型只调用了工具，没有产生文本回答 | 属正常兜底行为，换更明确的提示词 |
| 工具结果提示 `no permission prompt available` | 无头模式下 ASK 类操作默认拒绝 | 加 `--permission-mode auto`（确认风险后） |
| 报错 `Use -p "<prompt>" for one-shot runs` | 提示词没跟在 `-p` 后面 | 用 `tinycode -p "你的任务"` |
| 会话没有被保存 | 一次性模式默认不持久化 | 需要 `--continue` 或 `--session <id>` |
| `auto` 也无法执行某命令 | 触发了硬拒绝规则 | 这是设计使然，任何模式都不可绕过 |

Sources: [args.ts](src/cli/args.ts#L87-L91), [manager.ts](src/permissions/manager.ts#L103-L106)

## 延伸阅读路径

一次性模式只是权限体系的一个切面。若想理解 ASK/AUTO/DENY 三级判定是如何产生的，请继续阅读 [Shell 风险分类器：safe、write 与 destructive 三级判定](13-shell-feng-xian-fen-lei-qi-safe-write-yu-destructive-san-ji-pan-ding)；想看完整裁决链（包括记忆模式与硬拒绝优先级）请转到 [权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)；TUI 对话框与无头模式的系统性对比则在 [审批交互面：TUI 对话框与无头模式的差异化语义](15-shen-pi-jiao-hu-mian-tui-dui-hua-kuang-yu-wu-tou-mo-shi-de-chai-yi-hua-yu-yi)。若关心会话恢复的目录匹配细节，[会话生命周期：新建、--continue 目录匹配与 /new 轮换](20-hui-ha-sheng-ming-zhou-qi-xin-jian-continue-mu-lu-pi-pei-yu-new-lun-huan) 有完整展开。