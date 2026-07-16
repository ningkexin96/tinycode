TinyCode 的权限审批只有一个闸门——`PermissionManager.check()`，但它面向两种截然不同的宿主环境：持有终端画面的 TUI，以及没有任何交互通道的无头 `-p` 模式。本文剖析这套"同一闸门、差异宿主"的设计如何通过一个**可选的提示回调**实现，以及为什么缺失回调时系统选择"安全拒绝"而非崩溃或放行。关于裁决规则本身（safe/write/destructive 三级分类、硬拒绝优先级）请先阅读 [Shell 风险分类器：safe、write 与 destructive 三级判定](13-shell-feng-xian-fen-lei-qi-safe-write-yu-destructive-san-ji-pan-ding) 与 [权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)，本文聚焦在它们之上的**交互层**。

## 设计原点：可选的 PromptFn 是一切差异的根源

整个差异化语义收敛在一个类型定义上。`PermissionRequestView` 承载展示给人类的信息（工具名、单行标题、多行详情、原因），`PromptOutcome` 是三种可能的人类答复（`once` / `always` / `deny`），而连接二者的 `PromptFn` 在 `ManagerOptions` 中被声明为**可选字段**：

```ts
interface ManagerOptions {
  mode: "ask" | "auto";
  projectRoot: string;
  prompt?: PromptFn;   // ← 宿主可以不提供
}
```

这个可选项就是架构上的刻意留白：权限管理器不知道自己活在终端里还是管道里，它只知道"如果需要问人而没有人可问，就拒绝"。源码顶部的文档注释直接写明了这一契约："In 'ask' mode the host supplies a prompt callback (TUI dialog or CLI fallback); **a missing callback denies safely instead of crashing**"。这是典型的 fail-closed 设计——交互能力的缺失永远倒向限制而非放权。

Sources: [manager.ts](src/permissions/manager.ts#L3-L35)

## 宿主分叉点：谁注入了 setPrompt

理解差异的关键在于追踪 `setPrompt` 的调用位置——全仓库只有一处。`TuiApp` 在构造函数中把模态对话框挂为权限提示回调：

```ts
this.deps.permissions.setPrompt((request) => showPermissionDialog(this.tui, request));
```

而 `runPrintMode`（`-p` 模式的入口）构建 harness 时显式将模式默认为 `"ask"`，却**从不调用** `setPrompt`，源码注释直白地陈述了后果："Headless runs persist only when explicitly resuming; ASK verdicts deny because there is no dialog — auto-approval requires an explicit opt-in." 两条路径共用同一个由 `bootstrapHarness` 装配的 `PermissionManager` 实例，因此差异完全由"是否有人接听电话"决定，而非两套裁决逻辑。

```mermaid
flowchart TD
    A["tinycode (交互启动)"] --> B["TuiApp 构造函数"]
    B -->|"setPrompt(showPermissionDialog)"| G["PermissionManager.check()"]
    C["tinycode -p '...'"] --> D["runPrintMode()<br/>默认 mode=ask<br/>不调用 setPrompt"]
    D --> G
    G -->|"规则 allow"| H["放行执行"]
    G -->|"规则 deny"| I["硬拒绝"]
    G -->|"ASK + 已记忆模式"| H
    G -->|"ASK + mode=auto"| H
    G -->|"ASK + 有 prompt"| J["TUI 弹出模态对话框<br/>等待人类选择"]
    G -->|"ASK + prompt 为空<br/>(仅无头路径)"| I
```

这张图的阅读前提：`check()` 内部按"静态规则 → 记忆模式 → 运行模式 → 提示回调"的顺序短路求值，前四条路径在两种宿主中行为完全一致，唯一的分叉发生在最后一条。

Sources: [app.ts](src/tui/app.ts#L117)、[index.ts](src/cli/index.ts#L96-L133)、[bootstrap.ts](src/bootstrap.ts#L83-L87)

## TUI 侧：模态对话框的交互契约

`showPermissionDialog` 返回一个 Promise，用 Pi TUI 的覆盖层机制在屏幕中央渲染一张自适应宽度的卡片（宽度钳制在 50–72 列之间，随请求标题长度伸缩）。卡片内容由四部分组成：黄色高亮的 "TinyCode wants to run:" 标题、请求标题本体、灰色缩进的多行详情（如 edit 工具的替换前后文本对比）、以及灰色的判定原因。三个选项构成一个 `SelectList`：

- **Allow once** —— 本次放行，不留痕迹；
- **Always allow this pattern** —— 写入会话内记忆，同族请求后续免弹窗；
- **Deny** —— 拒绝，且选项描述栏复显判定原因，让用户知道"为什么会被问到"。

两个防御性细节值得注意。其一，焦点交给列表后存在 `settled` 布尔守卫，保证 Promise 只被 resolve 一次；其二，用户按 **Esc 或任何取消手势等价于 Deny**（`list.onCancel = () => finish("deny")`）——犹豫不会悬挂代理循环，只会否决本次操作。详情文本在上游就被裁剪过（`renderDetail` 截断到 400 字符并标注剩余长度），对话框侧再做二次防线（最多渲染 12 行，超出以 `…` 结尾），确保再长的 diff 也无法撑爆终端。

键盘交互契约有单元测试逐键验证：直接回车选中默认第一项 "Allow once"；下箭头一次后回车选 "Always"；下两次后回车选 "Deny"。这意味着最快的确认路径是一次按键放行，而拒绝需要三次按键——默认值偏向"看得见才允许"，但成本刻意压低。

```mermaid
sequenceDiagram
    participant Agent as 代理循环
    participant PM as PermissionManager
    participant Dlg as 权限对话框(overlay)
    participant User as 用户
    Agent->>PM: check("bash", {command})
    PM->>Dlg: showPermissionDialog(request)
    Dlg->>User: 居中卡片 + SelectList
    User->>Dlg: ↑↓ 导航 / Enter 确认 / Esc
    alt Esc 或选中 Deny
        Dlg-->>PM: "deny"
    else 选中 Allow once
        Dlg-->>PM: "once"
    else 选中 Always
        Dlg-->>PM: "always" → 记录前缀模式
    end
    PM-->>Agent: Decision {allow|deny, reason}
```

Sources: [permission-dialog.ts](src/tui/permission-dialog.ts#L16-L71)、[manager.ts](src/permissions/manager.ts#L126-L161)、[tui.test.ts](tests/tui.test.ts#L131-L158)

## "Always allow" 的记忆粒度与会话边界

选择 "Always" 后，管理器并非记住整条命令，而是提炼出一个**审批家族前缀**：bash 命令取前两个词（`npm install foo` 归纳为 `npm install`），其他工具取"工具名 + 路径首词"。匹配时做规范化的小写比较，且要求完整命中词边界（相等或以 `<prefix> ` 开头），因此 `npm install` 的记忆不会误放行 `npm uninstall`。两点边界必须澄清：这些模式存储在 `PermissionManager` 实例的私有数组中，**纯内存、不落盘**，进程退出即清零；同时它们排在硬拒绝之后求值，即使手工注入 `rm -rf` 前缀的记忆也无法越过灾难性命令拦截。`/status` 斜杠命令会实时显示当前模式与已积累的记忆数量，供会话中途审计。

Sources: [manager.ts](src/permissions/manager.ts#L37-L80)、[manager.ts](src/permissions/manager.ts#L113-L117)、[slash.ts](src/tui/slash.ts#L147)

## 无头侧：ASK 即拒绝的完整推导链

`-p` 模式的拒绝不是一条特殊分支，而是上一节设计的自然推论：模式默认 `ask`（CLI 未传 `--permission-mode` 时）+ `prompt` 字段保持 `undefined` → `check()` 走到 ASK 回退处发现无人应答，返回 `{ action: "deny", reason: "no permission prompt available: ..." }`。这个字符串随后被 `TinyCodeRuntime` 的 `beforeToolCall` 钩子包装成 `Permission denied: ...` 作为工具错误回灌给模型，代理会据此调整叙述（E2E 测试里模型回复"I could not delete files because permission was denied."），而不是无声失败。

三条测试共同钉死了这套语义的边界：ask 模式下 safe 级命令（`git status`）照常执行，证明无头模式不是一刀切禁用工具；ask 级操作（`npm install left-pad`）在不弹任何对话框的情况下被拒，且工作区确实没有产生 `node_modules`；显式传入 `auto` 则同一编辑操作恢复自动化。特别值得注意的是测试自身的防御动作——`beforeEach` 中显式 `delete process.env.TINYCODE_PERMISSION_MODE`，防止开发者环境中泄漏的环境变量把隐式 auto 带进测试，这反过来提醒使用者：该环境变量是全局旁路，CI 中应当审慎设置。

Sources: [index.ts](src/cli/index.ts#L103-L116)、[runtime.ts](src/agent/runtime.ts#L44-L53)、[permission-hardening.test.ts](tests/permission-hardening.test.ts#L74-L114)、[harness.e2e.test.ts](tests/harness.e2e.test.ts#L107-L128)

## 两种宿主的语义对照

| 维度 | TUI 交互模式 | 无头 `-p` 模式 |
|---|---|---|
| prompt 回调注入 | 构造时 `setPrompt(对话框)` | 从不注入 |
| ASK 判定的归宿 | 弹出居中模态对话框 | 直接拒绝，reason 含 `no permission prompt available` |
| 用户取消/Esc | 等价于 Deny | 不存在此概念 |
| "Always" 记忆 | 可用，会话内存活、进程退出即失 | 不可达（无法触发弹窗） |
| 恢复自动化的途径 | 启动参数 / 配置 / 环境变量设为 auto | 必须显式 `--permission-mode auto` 或 `TINYCODE_PERMISSION_MODE=auto` |
| 提示过程抛异常 | 被 catch 后转为 deny（`permission prompt failed`） | 同样逻辑，但通常走不到 prompt |
| 决策对模型的呈现 | 统一为工具错误消息 `Permission denied: <reason>` | 相同 |

表格揭示的本质是：**差异只存在于"ASK 判定如何抵达人类"这一环**，其余环节（规则求值、硬拒绝、auto 语义、决策回灌格式）完全共享同一份实现。

Sources: [manager.ts](src/permissions/manager.ts#L95-L123)、[permission-dialog.ts](src/tui/permission-dialog.ts#L54-L63)

## 共同底线：提示失败与硬拒绝的不可协商性

无论哪种宿主，有两类语义绝不因交互面的不同而松动。第一，提示回调本身若抛出异常，`check()` 用 try/catch 兜住并将异常消息编入拒绝理由——一个渲染崩坏的对话框不可能意外变成放行通道。第二，硬拒绝位于整条裁决链的最前端，在记忆模式、auto 模式和提示回调之前就短路返回；测试专门构造了"已记忆 `rm -rf` 前缀 + 提示必然回答 always"的最坏场景，断言灾难命令依然被拒且**提示函数根本未被调用**。端到端层面，即使在显式 auto 的无头运行中，`mkfs.ext4` 这类命令仍以含 "catastrophic" 字样的错误收场。

Sources: [manager.ts](src/permissions/manager.ts#L82-L112)、[permission-hardening.test.ts](tests/permission-hardening.test.ts#L50-L71)

## 模式从哪里来：三级配置链与运行时观测

`ask`/`auto` 的最终取值遵循 **CLI 参数 > 环境变量 > 配置文件** 的优先级。CLI 层对 `--permission-mode`/`--perm` 做严格枚举校验（非 ask/auto 直接报错退出）；加载器读取 `TINYCODE_PERMISSION_MODE` 环境变量覆盖配置文件中的 `permissionMode` 字段；Zod schema 将两者约束为二元枚举。`buildHarnessFromCli` 在装配完成后若检测到 CLI 标志则调用 `applyPermissionMode` 二次覆写，保证标志的最高优先级。运行期间可通过 `/status` 查看 `mode=` 与记忆模式数量，但当前代码库中没有运行时切换模式的斜杠命令——模式变更需要重启进程，这本身就是一种安全姿态：审批强度不会在会话中途被悄悄放宽。

Sources: [commands.ts](src/cli/commands.ts#L56-L87)、[args.ts](src/cli/args.ts#L57-L65)、[loader.ts](src/config/loader.ts#L96-L105)、[schema.ts](src/config/schema.ts#L21-L22)

## 小结与延伸阅读

审批交互面的全部差异化语义可以压缩为一句话：**权限管理器只认回调，宿主决定回调是否存在；不存在时，拒绝是唯一体面的答案**。TUI 通过一个带取消即拒绝、失败即拒绝双重兜底的模态对话框兑现"人在回路"，无头模式则通过"不接线"这一最朴素的方式继承了同样的 fail-closed 哲学。若要继续深入，推荐路线：先回到裁决规则的完整排序 [权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)，再到无头模式的日常使用视角 [一次性模式（-p）：无头运行与权限默认拒绝语义](5-ci-xing-mo-shi-p-wu-tou-yun-xing-yu-quan-xian-mo-ren-ju-jue-yu-yi)；关心这套机制的边界与局限者应读 [安全模型声明：审批层加路径守卫并非操作系统沙箱](16-an-quan-mo-xing-sheng-ming-shen-pi-ceng-jia-lu-jing-shou-wei-bing-fei-cao-zuo-xi-tong-sha-xiang)，想了解对话框所处的渲染体系则参见 [流式 TUI 组成：组件树、事件映射与显式重绘规则](24-liu-shi-tui-zu-cheng-zu-jian-shu-shi-jian-ying-she-yu-xian-shi-zhong-hui-gui-ze)。