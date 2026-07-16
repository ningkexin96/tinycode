本文剖析 TinyCode 测试工程的核心：如何在不访问任何网络的前提下，用一段预先编排好的"模型剧本"驱动真实的 Pi Agent 运行时、七大内置工具、权限闸门、上下文管理与会话持久化，完成一次端到端的"诊断—修复—验证"闭环。核心思想只有一句话——**只替换 LLM 边界，其余子系统全部真实运行**。理解这一页需要先了解 [Harness 装配流程](7-harness-zhuang-pei-liu-cheng-bootstrap-ru-he-chuan-lian-quan-bu-zi-xi-tong) 与 [TinyCodeRuntime 解剖](8-tinycoderuntime-jie-pou-wu-ge-ce-lue-gou-zi-jie-ru-pi-dai-li-xun-huan)。

Sources: [harness.e2e.test.ts](tests/harness.e2e.test.ts#L10-L19)

## 设计原则：只替换模型边界，其余全部真实

传统单元测试把每个模块隔离后逐一验证，但智能体系统的价值恰恰在于各子系统的协作顺序：权限闸门在工具执行之前裁决、截断在工具执行之后介入、会话在消息定稿时落盘。任何一层被 mock 掉，协作契约就失去了验证机会。因此这套 E2E 的唯一替身是 `streamFn` 背后的模型提供方——一个确定性的 faux provider，它按脚本逐条吐出 `AssistantMessage`，而 Agent 循环对此毫无察觉，照常发起工具调用、等待结果、继续推理。

这种架构带来的验证覆盖面可以用一张矩阵说清：

| 子系统 | 是否被 Mock | 验证方式 |
| --- | --- | --- |
| Pi Agent 循环 | ❌ 真实 | 断言助手消息与工具调用的精确序列 |
| 七大内置工具 | ❌ 真实 | 断言 bash 输出、edit diff、磁盘最终状态 |
| PermissionManager | ❌ 真实 | 断言危险命令被拒、auto 模式放行 |
| ContextManager | ❌ 真实 | 作为 afterToolCall 钩子随循环运行 |
| SessionManager + JSONL 存储 | ❌ 真实 | 断言落盘记录可完整回放 |
| LLM 提供方 | ✅ 替换为脚本 | 脚本本身就是测试输入 |

Sources: [harness.e2e.test.ts](tests/harness.e2e.test.ts#L16-L19), [runtime.ts](src/agent/runtime.ts#L8-L15)

## Mock 模型的注入链路

注入发生在 `bootstrapHarness` 的最前端。当传入 `mock: true` 或环境变量 `TINYCODE_MODEL=mock` 时，`ModelRegistry.enableMock()` 会向 pi-ai 注册一个名为 `mock/tinycode-mock` 的确定性提供方，并把它挂进统一的模型集合。此后 `resolve()` 在已注册 mock 且调用方未显式指定 provider/model 时优先返回这个 mock 模型——这意味着测试代码无需关心模型选择逻辑，装配流程与生产路径完全同构。

```mermaid
flowchart LR
    subgraph Test["测试侧"]
        SC["script() 剧本"] -->|"setResponses"| MH["mockHandle"]
    end
    subgraph Reg["ModelRegistry"]
        EM["enableMock()"] --> FP["fauxProvider(mock)"]
        FP --> SP["models.setProvider"]
        RES["resolve()"] --> GM["getModel()"]
    end
    subgraph Loop["Agent 循环（真实）"]
        AG["Agent"] -->|"每轮补全"| SFN["registry.streamFn"]
    end
    MH -.响应队列.- FP
    SP ==> RES
    SFN --> SS["streamSimple → 依次弹出脚本条目"]
```

值得注意的细节是 `enableMock()` 在注册时会预置一条默认回复，提示用户配置真实 API key——这让 `tinycode --mock` 与 `-p` 一次性模式即使没有任何脚本能跑出有用输出；而测试通过 `setResponses()` 整体覆写这条默认值。CLI 侧还有一条容错路径：未配置任何密钥时交互式启动不报错退出，而是自动降级到 mock 模式并在 UI 内引导用户完成配置。

Sources: [registry.ts](src/model/registry.ts#L48-L66), [registry.ts](src/model/registry.ts#L68-L81), [bootstrap.ts](src/bootstrap.ts#L69-L81), [index.ts](src/cli/index.ts#L46-L69)

## 脚本编写原语：faux 助手消息与工具调用

pi-ai 导出的 faux 构造器是剧本的最小词汇表。每个剧本条目就是一条完整的 `AssistantMessage`，可以是带工具调用的中间轮次，也可以是终止循环的纯文本回复：

| 原语 | 作用 |
| --- | --- |
| `fauxToolCall(name, args)` | 构造单个工具调用块，如 `bash`、`read`、`edit` |
| `fauxAssistantMessage(content)` | 包装内容块为数组或直接给字符串（后者即终止轮） |
| `setResponses(steps)` / `appendResponses(steps)` | 覆写 / 追加响应队列，支持工厂函数实现动态响应 |

主 E2E 的剧本共五轮，模拟一个真实工程师的修 bug 节奏：先跑测试看失败、再读源码定位问题、然后编辑修复、重跑测试确认通过、最后给出总结陈词。注意剧本作者实际上是在扮演 LLM 的角色——他必须预判每一轮工具会返回什么，并据此写出下一轮合理的动作。

```ts
function script(): AssistantMessage[] {
  return [
    fauxAssistantMessage([fauxToolCall("bash", { command: "node add.test.js" })]),
    fauxAssistantMessage([fauxToolCall("read", { path: "add.js" })]),
    fauxAssistantMessage([
      fauxToolCall("edit", { path: "add.js", oldText: "return a - b;", newText: "return a + b;" }),
    ]),
    fauxAssistantMessage([fauxToolCall("bash", { command: "node add.test.js" })]),
    fauxAssistantMessage("Fixed! add() now returns a + b and all tests pass."),
  ];
}
```

这里隐含着整个策略成立的前提：**线性脚本要求所有工具输出完全可预测**。fixture 项目刻意做得极小且零依赖（`node add.test.js` 直接用 `node:assert` 断言），保证失败输出中的 `AssertionError` 与成功输出中的 `all tests passed` 逐字节稳定，剧本才敢硬编码后续动作。

Sources: [harness.e2e.test.ts](tests/harness.e2e.test.ts#L47-L57), [faux.d.ts](node_modules/@earendil-works/pi-ai/dist/providers/faux.d.ts#L20-L36), [add.js](fixtures/broken-project/add.js#L1-L5)

## E2E 主场景：一次完整的"诊断—修复—验证"闭环

测试主体分四步走：装配 → 注入剧本 → 发起 prompt → 四层断言。下图展示脚本驱动的循环时序：

```mermaid
sequenceDiagram
    participant T as 测试进程
    participant H as Harness
    participant M as Mock 模型（剧本）
    participant A as Agent 循环
    participant P as 权限闸门
    participant X as 真实工具（bash/read/edit）
    participant S as Session JSONL

    T->>H: bootstrapHarness({ mock:true, permissionMode:"auto" })
    T->>M: setResponses(script())
    T->>H: prompt("Fix the failing test")
    loop 五轮剧本消费
        M-->>A: AssistantMessage(toolCall)
        A->>P: beforeToolCall 校验（auto 放行）
        A->>X: 执行真实命令
        X-->>A: stdout/stderr/diff
        A->>S: message_end 追加落盘
        A->>M: 工具结果回填上下文
    end
    M-->>A: 纯文本终局回复
    A-->>T: prompt() resolve
```

四层断言由外向内递进，各自锚定一类契约。第一层验证**消息流拓扑**：扁平化全部助手消息后，工具调用名必须严格等于 `["bash", "read", "edit", "bash"]`，`toolResult` 角色消息恰好 4 条——这证明脚本被按序消费、无额外轮次混入。第二层验证**工具结果的语义细节**：第一次 `bash` 的结果 `isError` 为 false 但输出包含 `✗ exit 1` 与 `AssertionError`（bash 工具把非零退出码编码进文本而非错误标志，这是留给模型自行判断的行为契约）；第二次则包含 `all tests passed`；edit 结果的 `details` 中含 `"additions":1`，证明 diff 计算真实发生。

第三层验证**物理世界副作用**：断言结束后直接读取磁盘上的 `add.js`，必须包含 `return a + b;` 且不再含 `a - b`——工具不是在内存里演戏，而是真的改了文件。第四层验证**持久化闭环**：通过 `session.load(sessionId)` 回放会话，消息数必须与内存中的 transcript 完全一致。两个重型测试将超时放宽到 60 秒（vitest 全局默认 30 秒），因为真实子进程派生和文件 IO 需要时间余量。

Sources: [harness.e2e.test.ts](tests/harness.e2e.test.ts#L59-L105), [runtime.ts](src/agent/runtime.ts#L44-L64), [storage.ts](src/session/storage.ts#L30-L39)

## 测试隔离：临时工作区与环境重定向

E2E 会真实写文件、真实执行 shell 命令，隔离机制因此比普通单测严格得多。`beforeEach` 用 `mkdtempSync` 在系统临时目录下创建一次性工作区，只拷入坏的 `add.js` 并内联生成配套的 `add.test.js`——仓库内的 fixture 永不被测试污染。用户级数据目录则通过 `TINYCODE_HOME` 重定向到临时区，使会话 JSONL、压缩工件等全部落在沙箱内；`afterAll` 统一关闭所有 harness，确保 MCP 子进程与子代理线程不泄漏到其他测试文件。

| 隔离手段 | 防护目标 |
| --- | --- |
| `mkdtempSync` 临时目录 | 每个用例独立的 projectRoot，互不可见 |
| 仅拷贝 fixture 单文件 | 仓库内 `fixtures/broken-project/` 保持只读 |
| `process.env.TINYCODE_HOME` 重定向 | 会话存储不写入开发者真实的 `~/.tinycode` |
| `afterAll` 批量 shutdown | 回收 MCP stdio 进程与并发子代理资源 |

Sources: [harness.e2e.test.ts](tests/harness.e2e.test.ts#L21-L45), [loader.ts](src/config/loader.ts#L7-L14)

## 同一骨架的三个衍生场景

主测试之外，同一份离线装配代码还覆盖了三条关键语义，每个场景只需换一份两轮以内的迷你剧本。其一是**权限默认拒绝**：`permissionMode: "ask"` 且无头模式下没有接通任何审批回调，询问语义安全地退化为拒绝——剧本让模型尝试 `rm -rf ./everything`，断言返回的唯一 `toolResult` 是 `isError: true` 且匹配 `/Permission denied/`。其二是同一危险类别在 **auto 模式下的放行**，形成对照实验，锁定两种权限模式的差异化行为。其三是**会话跨进程续接**：第一个 harness 写入便签后显式 `shutdown`，第二个 harness 以 `attach` 模式挂载同一 sessionId，断言历史消息被完整恢复进 live transcript（原始 `write` 的内容仍可检索），验证了 [会话生命周期](20-hui-hua-sheng-ming-zhou-qi-xin-jian-continue-mu-lu-pi-pei-yu-new-lun-huan) 所述的续接机制确实可用。

这三个场景共同说明该策略的可扩展性：新增一条横切语义的 E2E 覆盖，成本只是"几行剧本 + 几条断言"，不需要任何网络 stub 或 HTTP 录制基础设施。

Sources: [harness.e2e.test.ts](tests/harness.e2e.test.ts#L107-L128), [harness.e2e.test.ts](tests/harness.e2e.test.ts#L130-L144), [harness.e2e.test.ts](tests/harness.e2e.test.ts#L146-L183)

---

读完本页，建议继续前往 [质量门禁：PTY 级 TUI 测试与 Node 多版本 CI](27-zhi-liang-men-jin-pty-ji-tui-ce-shi-yu-node-duo-ban-ben-ci) 了解这些测试如何在 CI 中多版本运行；若想深挖 mock 提供方在模型选择链中的位置，参见 [模型注册表：多提供商选择链与 Mock 模型注入](25-mo-xing-zhu-ce-biao-duo-ti-gong-shang-xuan-ze-lian-yu-mock-mo-xing-zhu-ru)。