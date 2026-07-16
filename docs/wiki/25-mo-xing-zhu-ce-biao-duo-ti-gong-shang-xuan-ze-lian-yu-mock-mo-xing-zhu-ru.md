模型层是编码智能体的"发动机接口"：所有上层子系统（代理循环、上下文压缩、子代理）最终都通过一个统一的入口拿到可用的 LLM。本文剖析 TinyCode 的 `ModelRegistry`——它如何在几十个内置提供商之上实现一条确定性的**模型选择链**，以及如何通过注入一个脚本化的 **Mock 提供商**让整个智能体在零网络、零密钥的条件下完整运行。

## 注册表的定位：pi-ai 提供商集合的薄封装

`ModelRegistry` 本身不实现任何网络协议或认证逻辑，它是 pi-ai 库 `MutableModels` 集合的一层薄封装。构造函数中一行 `builtinModels()` 就注册了全部内置提供商（Anthropic、OpenAI、Groq、OpenRouter 等数十个），认证完全依赖环境变量（如 `ANTHROPIC_API_KEY`），注册表自身永不存储密钥。类注释明确了双重身份：真实使用时是全量内置提供商的持有者；测试和 `--mock` 模式下则额外挂载确定性 faux 提供商。

```mermaid
graph TB
    subgraph ModelRegistry["ModelRegistry（src/model/registry.ts）"]
        MODELS["models: MutableModels<br/>（pi-ai 提供商集合）"]
        MOCK["mock?: FauxProviderHandle<br/>（懒加载单例）"]
        CAP["outputCap?: number<br/>（max_tokens 钳制）"]
        STREAMFN["streamFn: StreamFn<br/>（统一流式出口）"]
    end
    subgraph Providers["注册进 models 的提供商"]
        BUILTIN["builtinModels()<br/>anthropic / openai / groq / ..."]
        FAUX["fauxProvider('mock')<br/>tinycode-mock 模型"]
    end
    BUILTIN --> MODELS
    MOCK --> FAUX
    BOOT["bootstrapHarness"] -- "resolve(ref)" --> MODELS
    RUNTIME["TinyCodeRuntime"] -- "streamFn" --> STREAMFN
    SUBAGENTS["SubAgentManager"] -- "streamFn" --> STREAMFN
    SUMM["压缩摘要器"] -- "completeSimple" --> MODELS
```

两个导出类型构成对外的全部契约面：`ModelNotConfiguredError` 是携带可操作指引的专用错误类型（区别于通用异常，CLI 和 TUI 都靠它触发降级路径）；`ModelRef` 则是贯穿 CLI → 配置 → 注册表的 `{provider?, model?}` 二元组。

Sources: [registry.ts](src/model/registry.ts#L11-L21), [registry.ts](src/model/registry.ts#L23-L38)

## resolve() 的四级判定链

`resolve()` 是整个选择链的核心，接收一个可选的 `ModelRef`，按四级优先级收敛到一个具体模型实例。理解这条链的关键在于认识到每一级都是**精确匹配优先、模糊回退殿后**：

```mermaid
flowchart TD
    START["resolve(ref?)"] --> M1{"mock 已启用 且<br/>ref.provider == 'mock'<br/>或 ref 为空？"}
    M1 -- 是 --> RETMOCK["返回 mock 模型"]
    M1 -- 否 --> M2{"provider 与 model<br/>都显式给出？"}
    M2 -- 是 --> LOOKUP["models.getModel(provider, model)"]
    LOOKUP -- 未找到 --> ERR2["抛出：Unknown model<br/>提示 --list-models"]
    LOOKUP -- 找到 --> OK1["返回该模型"]
    M2 -- 否 --> M3{"仅给出 model？"}
    M3 -- 是 --> SCAN["遍历所有已注册提供商<br/>按 id 匹配第一个"]
    SCAN -- 未找到 --> ERR3["抛出：Unknown model id"]
    SCAN -- 找到 --> OK3["返回该模型"]
    M3 -- 否 --> AVAIL["getAvailable(provider?)<br/>检查各提供商环境变量密钥"]
    AVAIL -- 有可用 --> FIRST["返回第一个可用模型"]
    AVAIL -- 为空 --> ERR4["抛出 ModelNotConfiguredError<br/>列出三种解决途径"]
```

第一级是 **mock 短路**：只要 faux 提供商已注册且调用方要么点名 `provider === "mock"`、要么完全不表达偏好，就直接返回 mock 模型——这保证 mock 一旦启用便不会被真实提供商"截胡"。第二级处理完整的 `provider/model` 对，做目录内的精确查找，查不到时报错信息会引导用户运行 `--list-models` 或检查配置文件。第三级只拿到裸 model id 时，跨全部提供商扫描同 id 模型（例如只写 `gpt-5` 不写 `openai/gpt-5`）。第四级是无任何偏好时的兜底：调用 pi-ai 的 `getAvailable()`，它逐个提供商检测环境变量中的 API 密钥（如 `OPENAI_API_KEY`），返回第一个通过认证检查的模型。

最终失败的报错信息值得注意——它不是一句干巴巴的"No model"，而是同时列出三条出路：设置任一提供商的环境变量密钥、在 `.tinycode/config.json` 写入 provider/model、或者用 `TINYCODE_MODEL=mock` 走离线脚本模型。这种"错误即文档"的设计让冷启动失败永远自带修复指南。

| 判定级 | 输入条件 | 匹配方式 | 失败行为 |
|---|---|---|---|
| 1. Mock 短路 | mock 已启用且（点名 mock 或无偏好） | 直接返回 | 不适用 |
| 2. 完整引用 | `provider` + `model` 均存在 | 目录精确查找 | 抛错并建议 `--list-models` |
| 3. 仅模型 ID | 只有 `model` | 跨提供商按 id 扫描 | 抛 Unknown model id |
| 4. 自动兜底 | 无偏好 | `getAvailable()` 认证检测取首个 | 抛三出路指引错误 |

Sources: [registry.ts](src/model/registry.ts#L72-L114)

## 配置来源与优先级：CLI 标志 > 环境变量 > config.json

`resolve()` 拿到的 `ModelRef` 并非凭空而来，它由三层来源合并而成。合并发生在两个位置：`loadConfig()` 先完成文件与环境变量的合并（环境变量覆盖文件），随后 `bootstrapHarness` 再用 CLI 解析结果覆盖前两者。

```mermaid
flowchart LR
    FLAG["CLI 标志<br/>--model openai/gpt-5"] -->|"parseModelRef"| REF
    ENV["TINYCODE_MODEL=openai/gpt-5<br/>（loader 中覆盖文件值）"] --> CONFIG
    FILE[".tinycode/config.json<br/>provider + model 字段"] --> CONFIG["loadConfig()"]
    CONFIG --> BOOT["bootstrapHarness:<br/>options.modelRef ?? config 字段"]
    FLAG --> BOOT
    BOOT --> REF["modelRef: ModelRef"]
    REF --> RESOLVE["registry.resolve(modelRef)"]
```

字符串到结构化引用的转换由 `parseModelRef` 完成：按**第一个**斜杠切分，无斜杠则整体视为 model id。这意味着 `TINYCODE_MODEL=openai/gpt-5` 会拆成 `{provider: "openai", model: "gpt-5"}`，而 `TINYCODE_MODEL=gpt-5` 只设置 model、保留文件中的 provider。有一个刻意的例外：加载器在解析环境变量时会**跳过字面量 `"mock"`**——因为 mock 不是某个真实提供商下的模型，它的启用属于注册表职责，若混入 config 会污染后续的真实模型解析（测试专门验证了这一点）。`buildHarnessFromCli` 的文档注释将优先级总结为一句："flags > environment > config file"，而 bootstrap 内部的空值合并（`options.modelRef?.provider ?? config.provider`）正是这句话的实现载体。

| 来源 | 形态 | 解析位置 | 特殊规则 |
|---|---|---|---|
| CLI 标志 `-m/--model` | `"provider/model"` 字符串 | `parseModelRef`（args.ts） | 最高优先级 |
| 环境变量 `TINYCODE_MODEL` | 同上 | loader 环境覆盖段 | 值为 `"mock"` 时被忽略 |
| 项目配置文件 | `provider`/`model` 独立字段 | Zod schema 校验 | 可安全提交入库 |

Sources: [loader.ts](src/config/loader.ts#L26-L32), [loader.ts](src/config/loader.ts#L96-L100), [args.ts](src/cli/args.ts#L85-L91), [commands.ts](src/cli/commands.ts#L59-L79), [bootstrap.ts](src/bootstrap.ts#L77-L81), [schema.ts](src/config/schema.ts#L17-L20)

## Mock 模型注入：faux 提供商与确定性脚本

`enableMock()` 通过 pi-ai 的 `fauxProvider` 工厂注册一个 id 为 `"mock"`、唯一模型为 `tinycode-mock` 的假提供商，并用 `setProvider` 将其并入 `MutableModels` 集合——从此 mock 与真实提供商在类型系统里完全平权，代理循环无法区分自己正在对话的是 Claude 还是一段脚本。方法是幂等的单例：重复调用不会重复注册，但每次都会重置响应队列为默认引导消息。

这个默认回复是为 `-p` 一次性模式准备的贴心设计：用户在没有任何密钥的情况下跑 `tinycode -p "hello"`，也能得到一段说明如何配置真实提供商的有用输出，而不是空转。测试场景则会立刻用 `setResponses` 覆盖这份默认脚本，注入自己的对话序列。

Mock 有三条互斥又互补的激活路径：

```mermaid
sequenceDiagram
    participant User as 用户/CI
    participant CLI as cli/index.ts
    participant Boot as bootstrapHarness
    participant Reg as ModelRegistry

    User->>CLI: 启动命令
    alt 显式指定 --mock 或 TINYCODE_MODEL=mock
        CLI->>Boot: options.mock = true
        Boot->>Reg: enableMock()
        Reg-->>Boot: mock 模型
    else 无任何密钥的交互式启动
        Boot->>Reg: resolve(ref)
        Reg-->>Boot: throw ModelNotConfiguredError
        CLI->>Boot: 用 mock:true 重建 harness
        Note over CLI: 错误消息转为 UI 引导通知
        Boot->>Reg: enableMock()
    end
    CLI->>User: 正常进入会话（带引导横幅）
```

第一条是显式路径：`--mock` 标志或 `TINYCODE_MODEL=mock` 环境变量直接令 bootstrap 调用 `enableMock()`。第二条是**交互式引导回退**：TUI 启动时若 `resolve()` 抛出 `ModelNotConfiguredError`，CLI 不拒绝启动，而是捕获该异常后以 `mock: true` 重建整个 harness，并把原始错误消息作为 `onboarding` 通知传给界面——用户看到的是一个能用的应用加一段"去配密钥"的引导，而非一条退出码。第三条隐含在第一级的短路逻辑中：一旦 mock 已注册，空的 `ModelRef` 也会自动命中它。PTY 冒烟测试同时验证了这两条主路径：正常启动注入 `TINYCODE_MODEL=mock`，而清空全部密钥变量后启动则应触发引导流程。

Sources: [registry.ts](src/model/registry.ts#L48-L70), [bootstrap.ts](src/bootstrap.ts#L69-L76), [cli/index.ts](src/cli/index.ts#L46-L71), [tui.pty.test.ts](tests/tui.pty.test.ts#L74-L88)

## streamFn：输出上限钳制与统一流入口

注册表暴露的 `streamFn` 是 handed 给 Pi 运行时的唯一流式函数，也是输出预算的最后一道闸门。每次请求时它先取调用方指定的 `maxTokens`（缺省回退到模型目录里的 `maxTokens` 值），再与 `outputCap` 取最小值后才转发给底层的 `streamSimple`。钳制上限默认 16384，来自 bootstrap 中的 `config.maxOutputTokens ?? 16384`，其动机写在注释里：完整 32k+ 的模型输出上限会触发预付费信用的预检扣款（典型如 OpenRouter 返回 402），提前钳制可以避免一次失败的大额预授权。

这个闭包的价值在于**一处钳制、处处生效**：主代理循环、子代理管理器（`SubAgentManager` 构造参数中的 `streamFn`）、乃至压缩摘要器都从同一个 harness 拿到同一份流函数，不存在某条旁路绕过预算控制。摘要器走的是另一条捷径——直接调用 `models.models.completeSimple` 做一次性补全，这是注册表把底层集合设为 `readonly` 公开成员的原因之一：受信任的内部分层可以直接使用完整 `Models` API，而运行时主链路统一走 `streamFn`。

| 消费方 | 使用接口 | 是否经过 outputCap 钳制 |
|---|---|---|
| TinyCodeRuntime 主循环 | `streamFn` | 是 |
| SubAgentManager 工作线程 | `streamFn` | 是 |
| 会话压缩摘要器 | `completeSimple` 直调 | 否（单次小请求） |

Sources: [registry.ts](src/model/registry.ts#L40-L46), [registry.ts](src/model/registry.ts#L116-L124), [bootstrap.ts](src/bootstrap.ts#L69-L72), [bootstrap.ts](src/bootstrap.ts#L220-L226)

## 消费方全景：谁在使用注册表

围绕 `ModelRegistry` 的消费方形成清晰的分层：装配期只有 bootstrap 一个调用者，运行期则由 CLI 命令、TUI 斜杠命令和测试套件分别接入。`--list-models` 子命令构建一个明确禁用 mock 的临时 harness，然后调用 `availableWithAuth()` 打印前 50 个有认证配置的模型；一个都没有时输出与注册表报错一致的修复指引并以退出码 1 结束。TUI 的 `/model` 命令复用同一个 `resolve()`：不带参数时列出当前模型与最多 15 个可用选项，带参数时解析新引用并调用 `runtime.setModel()` 热切换——运行中的会话无需重启即可更换大脑。

测试侧的接入点则是 `mockHandle` getter：E2E 测试在 `bootstrapHarness({ mock: true })` 之后立即调用 `harness.models.mockHandle!.setResponses(script())` 注入五步脚本（bash → read → edit → bash → 最终答复），驱动真实的工具执行流水线跑通全程；子代理单元测试同样用 `registry.enableMock()` 加共享的 `streamFn` 构建被测对象。这一模式让整个测试套件保持全离线，同时覆盖的却是生产代码路径本身。

| 消费方 | 调用的注册表 API | 目的 |
|---|---|---|
| `bootstrapHarness` | `setMaxOutputTokens` / `enableMock` / `resolve` / `streamFn` | 装配期选定模型并分发流函数 |
| `--list-models` 命令 | `availableWithAuth()` | 展示有密钥的模型清单 |
| `/model` 斜杠命令 | `availableWithAuth()` / `resolve()` | 会话内查看与热切换模型 |
| E2E 与单元测试 | `enableMock()` / `mockHandle.setResponses()` | 脚本化驱动真实代理循环 |

Sources: [cli/index.ts](src/cli/index.ts#L36-L37), [cli/index.ts](src/cli/index.ts#L149-L170), [slash.ts](src/tui/slash.ts#L86-L107), [harness.e2e.test.ts](tests/harness.e2e.test.ts#L51-L68), [subagents.test.ts](tests/subagents.test.ts#L12-L27)

## 小结

`ModelRegistry` 用不到 140 行代码回答了三个问题：**有哪些模型可选**（构造即注册全量内置目录）、**选哪一个**（四级判定链加上三层配置来源合并）、**没有可用时怎么办**（结构化错误驱动 TUI 无缝降级到 mock 引导）。Mock 注入的设计尤其体现了骨架项目的教学意图——同一个 `streamFn` 接口背后，真实 HTTP 流与确定性脚本可以无损互换，这正是后续离线 E2E 测试体系能够成立的地基。

想继续深入，推荐两条路线：了解这套 mock 如何驱动完整代理循环做端到端验证，请阅读[全离线测试策略：脚本化 Mock 模型驱动真实代理循环的 E2E](26-quan-chi-xian-ce-shi-ce-lue-jiao-ben-hua-mock-mo-xing-qu-dong-zhen-shi-dai-li-xun-huan-de-e2e)；了解注册表在整体装配中的位置，请回到[Harness 装配流程：bootstrap 如何串联全部子系统](7-harness-zhuang-pei-liu-cheng-bootstrap-ru-he-chuan-lian-quan-bu-zi-xi-tong)。配置字段本身的细节则在[配置体系：config.json、环境变量与密钥安全管理](3-pei-zhi-ti-xi-config-json-huan-jing-bian-liang-yu-mi-yao-an-quan-guan-li)中有完整展开。