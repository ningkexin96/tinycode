本页是 TinyCode 交互式终端界面的日常操作手册。读完你将掌握：屏幕四个区域的分工、中断与退出的按键语义、输入框的多行与历史记录技巧、全部 12 条斜杠命令的作用，以及权限弹窗和状态栏的读法。关于界面内部如何渲染这些元素（组件树与重绘规则），请进阶阅读[流式 TUI 组成：组件树、事件映射与显式重绘规则](24-liu-shi-tui-zu-cheng-zu-jian-shu-shi-jian-ying-she-yu-xian-shi-zhong-hui-gui-ze)；本页只关注"怎么用"。

启动后你看到的第一行提示就是操作纲领："Type a task, or /help for commands. Ctrl+C aborts/exits."——输入任务描述即可开工，输入 `/help` 可随时查看命令清单。Sources: [app.ts](src/tui/app.ts#L43-L46)

## 一屏读懂界面布局

TinyCode 运行在终端的全屏模式（alt-screen）下，整个界面由上下两块组成：上方是可以滚动的对话记录区（transcript），下方固定堆叠着三行结构——忙碌指示器、输入框和状态栏。输入框获得焦点时边框呈亮蓝色，失焦时变灰，这是判断"键盘当前控制谁"的最直观信号。Sources: [app.ts](src/tui/app.ts#L48-L106)

```mermaid
flowchart TB
    subgraph SCREEN["全屏布局（自上而下）"]
        A["对话记录区 Transcript<br/>用户消息 · 助手流式回复 · 工具执行卡片 · 提示信息"]
        B["忙碌指示器 LoaderHost<br/>◐ thinking… 或 ◐ running N tool call(s)…"]
        C["输入框 Editor（亮蓝边框 = 有焦点）<br/>支持多行、历史记录、斜杠自动补全"]
        D["状态栏 StatusBar<br/>● ready/working · 模型 · ctx token 估算 · 会话 ID"]
    end
    A --> B --> C --> D
```

启动时若没有检测到任何模型 API Key，程序不会拒绝启动，而是降级进入 Mock 模式，并在对话区打印一段黄底"⚙ Setup required"引导信息，告诉你如何配置密钥后重启。这保证了零配置也能先熟悉界面。Sources: [app.ts](src/tui/app.ts#L172-L199)、[index.ts](src/cli/index.ts#L45-L69)

## 全局快捷键：中断与退出

无论焦点在哪里，以下三个组合键始终生效。它们的行为取决于代理是否正在工作（busy），理解这张表是安全使用的关键：

| 按键 | 空闲时 | 忙碌（模型回复中） |
|------|--------|-------------------|
| `Ctrl+C` | 第一次按下仅提示 "(press Ctrl+C again to exit)"；2 秒内再按才退出 | 立即中止当前任务，不退出程序 |
| `Escape` | 无效果 | 中止当前任务并显示 "Interrupted." |
| `Ctrl+D` | 立即退出 | 立即退出 |

Sources: [app.ts](src/tui/app.ts#L341-L357)

`Ctrl+C` 的双击设计值得展开说明：它把"打断任务"和"退出程序"两个意图合并到一个键上——忙碌时按它等于温和地叫停，空闲时则需要 2 秒内连按两次确认退出，避免手滑丢掉会话。代码用时间戳比较实现这个判定，两次按压间隔小于 2000 毫秒即视为确认。此外，真实终端通常把 Ctrl+C 以 SIGINT 信号而非原始字节送达，CLI 入口特意注册了信号处理器，把它路由到同一套中断逻辑，保证两条路径行为完全一致。Sources: [app.ts](src/tui/app.ts#L359-L376)、[index.ts](src/cli/index.ts#L80-L88)

## 输入框：多行输入、历史记录与自动补全

输入框由 pi-tui 的 Editor 组件提供，能力远超单行 readline。日常最常用的三件事如下表：

| 操作 | 按键 | 说明 |
|------|------|------|
| 提交 | `Enter` | 触发提交流程（见下一节） |
| 插入换行 | `Shift+Enter` 或 `Ctrl+J` | 编写多行任务描述 |
| 兼容换行技巧 | 行尾输入 `\` 后按 `Enter` | 终端不支持 Shift+Enter 时，反斜杠会被删除并转为换行而不提交 |
| 翻阅历史 | 光标在第一行按 `↑` / 在最后一行按 `↓` | 循环回溯本次运行提交过的每条输入 |
| 移动光标（多行内） | 多行文本中间按 `↑`/`↓` | 在行间移动光标而非翻历史 |
| 补全斜杠命令 | 输入 `/` 后 `Tab` | 弹出命令候选列表 |

Sources: [keybindings.js](node_modules/@earendil-works/pi-tui/dist/keybindings.js#L70-L75)、[editor.js](node_modules/@earendil-works/pi-tui/dist/components/editor.js#L646-L694)

历史记录的边界条件处理得很细致：只有当光标位于可视首行且编辑器为空或已在翻阅历史时，`↑` 才切换到上一条历史，否则就是普通的光标上移。这意味着你可以放心地在一条多行长任务里用方向键微调文字，而不会意外丢失正在编辑的内容。每次成功提交都会调用 `addToHistory` 把这条输入压入历史栈。Sources: [editor.js](node_modules/@earendil-works/pi-tui/dist/components/editor.js#L675-L694)、[app.ts](src/tui/app.ts#L240-L244)

斜杠命令的自动补全在应用装配时就绑定好了：全部命令名从 `SLASH_COMMAND_NAMES` 导出（它直接派生自帮助文本的第一列，天然保持同步），喂给 CombinedAutocompleteProvider，所以你在输入框敲出 `/he` 再按 `Tab` 就能补全为 `/help`。Sources: [app.ts](src/tui/app.ts#L108-L115)、[slash.ts](src/tui/slash.ts#L159)

## 一次提交的完整生命周期

从按下 Enter 到看见回应，内部经过一条清晰的分派流水线。理解它能帮你预判每种输入的去向：

```mermaid
flowchart TD
    S(["按下 Enter"]) --> T["去除首尾空白"]
    T --> E{"为空？"}
    E -- 是 --> X1["忽略，什么都不做"]
    E -- 否 --> H["存入历史记录 + 清空输入框"]
    H --> SL{"以 / 开头？"}
    SL -- 是 --> SC["executeSlashCommand 执行命令<br/>结果作为提示信息写入对话区"]
    SL -- 否 --> B{"代理正忙？"}
    B -- 是 --> W["显示 Still working — wait…<br/>本次输入被丢弃"]
    B -- 否 --> P["交给 runtime.prompt() 进入代理循环"]
```

Sources: [app.ts](src/tui/app.ts#L240-L265)

有两个细节对新手特别友好。其一，普通消息在忙碌期间不会被排队，而是直接拒绝并提示"Still working"，你必须等当前任务结束或按 `Escape` 打断后再发——这避免了消息交错导致的混乱。其二，斜杠命令不受忙碌限制，即使代理正在干活你也可以执行 `/status` 查看状态。Sources: [app.ts](src/tui/app.ts#L259-L264)

提交之后，对话区的更新由事件订阅驱动：助手回复逐字流入一个可更新的条目；每个工具调用开始时生成一张"● 工具名 参数摘要"卡片，结束时补上"✓ exit 0 · 2.4s"这类结果摘要；编辑类工具还会渲染带 `+`/`-` 标记的差异预览。Sources: [app.ts](src/tui/app.ts#L282-L330)、[tui.test.ts](tests/tui.test.ts#L37-L63)

## 斜杠命令速查表

全部 12 条命令如下。它们大小写不敏感（`/HELP` 等效于 `/help`），参数之间以空格分隔，未知命令会得到一句提示而不是报错崩溃：

| 命令 | 参数 | 作用 |
|------|------|------|
| `/help` | 无 | 显示命令帮助清单 |
| `/new` | 无 | 开启全新会话并重置代理上下文 |
| `/clear` | 无 | 仅清空当前对话上下文（不轮换会话文件） |
| `/resume` | `[id]` | 恢复指定历史会话；不带 id 时列出最近 10 条及用法提示 |
| `/sessions` | 无 | 列出已保存的会话（最多 20 条，含修改时间与消息数） |
| `/model` | `[provider/model]` | 不带参数列出已配置鉴权的可用模型；带参数则热切换模型 |
| `/skills` | 无 | 列出发现的技能及其描述 |
| `/mcp` | 无 | 显示各 MCP 服务器连接状态与工具数（✓ 连接 / ✗ 错误 / … 进行中） |
| `/agents` | 无 | 显示子代理并发状态与各报告条目 |
| `/compact` | 无 | 立即压缩旧对话轮次以释放上下文空间 |
| `/status` | 无 | 输出项目根目录、模型、token 估算、权限模式、已注册工具等全景诊断 |
| `/exit` | 无 | 退出 TinyCode（显示 "Bye."） |

Sources: [slash.ts](src/tui/slash.ts#L28-L41)、[slash.ts](src/tui/slash.ts#L44-L156)

几条命令的使用场景补充：`/new` 与 `/resume` 的底层是会话文件的轮换与挂载，涉及目录匹配等生命周期细节，见[会话生命周期：新建、--continue 目录匹配与 /new 轮换](20-hui-hua-sheng-ming-zhou-qi-xin-jian-continue-mu-lu-pi-pei-yu-new-lun-huan)。`/compact` 触发的摘要压缩策略与保护窗口见[Token 预算与自动压缩：会话摘要生成与保护窗口](18-token-yu-suan-yu-zi-dong-ya-suo-hui-hua-zhai-yao-sheng-cheng-yu-bao-hu-chuang-kou)。`/skills`、`/mcp`、`/agents` 分别对应三个扩展子系统，深入原理请读[技能系统：SKILL.md 发现与 load_skill 渐进式披露](21-ji-neng-xi-tong-skill-md-fa-xian-yu-load_skill-jian-jin-shi-pi-lu)、[MCP 集成：stdio 服务器并行连接与单点故障隔离](22-mcp-ji-cheng-stdio-fu-wu-qi-bing-xing-lian-jie-yu-dan-dian-gu-zhang-ge-chi)与[子代理监督：只读工作线程、并发上限与结构化报告回收](23-zi-dai-li-jian-du-zhi-du-gong-zuo-xian-cheng-bing-fa-shang-xian-yu-jie-gou-hua-bao-gao-hui-shou)。Sources: [slash.ts](src/tui/slash.ts#L55-L85)、[slash.ts](src/tui/slash.ts#L110-L137)

从架构角度看，这层命令处理被刻意设计成"纯逻辑"：`executeSlashCommand` 不直接触碰任何 UI，而是通过 `SlashContext` 接口声明它需要的能力（如 `loadSession`、`requestExit`），由 TUI 应用类实现该接口注入进来。这样同一套命令逻辑可以在无终端的环境下被测试，TuiApp 只需 `implements SlashContext` 即可对接。Sources: [slash.ts](src/tui/slash.ts#L9-L26)、[app.ts](src/tui/app.ts#L58)

## 权限对话框的按键操作

当代理想执行需要批准的操作（比如运行一条 shell 命令）时，屏幕中央会弹出模态对话框，列出三项选择。操作方式与传统列表一致：

| 按键 | 效果 |
|------|------|
| `↑` / `↓` | 在三个选项间移动高亮 |
| `Enter` | 确认当前高亮项 |
| `Esc`（取消） | 等同于选择 Deny（拒绝） |

默认高亮第一项 **Allow once**（仅允许一次）；第二项 **Always allow this pattern** 会记住同类操作模式以免重复打扰；第三项 **Deny** 直接拒绝。自动化测试精确固化了这套按键契约：默认项确认、按一次 ↓ 再确认选中 always、按两次 ↓ 再确认选中 deny。关于审批决策的完整裁决顺序与无头模式差异，见[权限闸门裁决顺序：硬拒绝、记忆模式、auto 与 ASK 回退](14-quan-xian-zha-men-cai-jue-shun-xu-ying-ju-jue-ji-yi-mo-shi-auto-yu-ask-hui-tui)与[审批交互面：TUI 对话框与无头模式的差异化语义](15-shen-pi-jiao-hu-mian-tui-dui-hua-kuang-yu-wu-tou-mo-shi-de-chai-yi-hua-yu-yi)。Sources: [permission-dialog.ts](src/tui/permission-dialog.ts#L31-L64)、[tui.test.ts](tests/tui.test.ts#L131-L150)

## 状态栏与忙碌指示器解读

底部状态栏是一条动态拼装的信息带，学会读它就能对系统状态一目了然：

```
● working · anthropic/claude-sonnet-4 tinycode · ctx ~12.3k · SUB-AGENTS 2/3 RUNNING · session abcdef12
```

各段含义：`● ready`（绿）表示空闲、`● working`（黄）表示模型工作中；模型名后跟项目根目录的**最后一级路径名**（避免长路径折行）；`ctx ~12.3k` 是当前上下文的 token 估算值，超过一千自动格式化为 k 单位；子代理段只在有代理运行时出现，`n/m` 表示运行数与并发上限 3；最后的会话段显示会话 ID 前 8 位。Sources: [status-bar.ts](src/tui/status-bar.ts#L16-L39)

输入框上方的忙碌指示器则回答"现在到底在干什么"：有待处理的工具调用时显示 `◐ running N tool call(s)…`，否则在模型思考时显示 `◐ thinking…`，空闲时整行隐藏。状态栏会在每个代理事件的开始与结束时刷新，因此这些数字是实时跟随代理循环跳动的。Sources: [app.ts](src/tui/app.ts#L380-L396)、[app.ts](src/tui/app.ts#L226-L238)

## 退出时发生了什么

无论通过 `/exit` 还是 `Ctrl+C` 双击触发退出，程序都不会瞬间消失：退出请求只是设置一个标志位，主循环每 100 毫秒检查一次，并且只在代理**不在忙碌状态**时才真正执行清理。清理过程会依次关闭 MCP 连接与子代理线程，然后停止 TUI 渲染。这个设计意味着即使你在模型回复途中请求退出，也会先得到体面的收尾而不是截断中的写入。Sources: [app.ts](src/tui/app.ts#L151-L153)、[app.ts](src/tui/app.ts#L202-L224)

## 新手五分钟上手清单

把前面所有知识串成一轮真实操作：启动后先输入 `/status` 确认模型与会话就绪；在输入框用一行文字描述任务并按 Enter；观察状态栏变黄、指示器转圈、工具卡片逐一落地；中途想改主意就按 `Esc` 打断；上下文变大后用 `/compact` 释放空间；干完活按两次 `Ctrl+C`（间隔小于 2 秒）退出。下次回来可用 `/sessions` 找到旧会话并用 `/resume <id>` 继续。Sources: [slash.ts](src/tui/slash.ts#L138-L153)、[app.ts](src/tui/app.ts#L351-L356)

## 下一步阅读

- 上一站：[配置体系：config.json、环境变量与密钥安全管理](3-pei-zhi-ti-xi-config-json-huan-jing-bian-liang-yu-mi-yao-an-quan-guan-li) —— 理解 `/model` 列表中"已配置鉴权"是怎么来的。
- 下一站：[一次性模式（-p）：无头运行与权限默认拒绝语义](5-ci-xing-mo-shi-p-wu-tou-yun-xing-yu-quan-xian-mo-ren-ju-jue-yu-yi) —— 同一套运行时的无终端形态。
- 进阶：[流式 TUI 组成：组件树、事件映射与显式重绘规则](24-liu-shi-tui-zu-cheng-zu-jian-shu-shi-jian-ying-she-yu-xian-shi-zhong-hui-gui-ze) —— 本页每个界面元素的实现原理。