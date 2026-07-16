TinyCode 的配置设计遵循一条朴素的原则：**能提交的配置与不能提交的密钥严格分离**。本页面向初学者，讲解配置从哪里来、以什么顺序生效，以及为什么 API 密钥被刻意排除在配置文件之外。读完本页，你将理解 `.tinycode/config.json` 的每个字段、全部环境变量的作用，以及启动时的密钥泄露防护机制。

## 三层配置来源：优先级链是如何形成的

TinyCode 没有引入任何配置框架，而是用三个互相叠加的配置层覆盖了绝大多数使用场景。优先级由注释明确声明：**命令行标志 > 环境变量 > 配置文件**，未被任何一层覆盖的字段最终落到代码内置的默认值上。

```mermaid
flowchart LR
    A["CLI 标志<br/>-m / --permission-mode"] -->|"最高优先级"| B["环境变量<br/>TINYCODE_MODEL 等"]
    B -->|"次之"| C["配置文件<br/>.tinycode/config.json"]
    C -->|"兜底"| D["内置默认值<br/>ask / 16384 / 30000..."]
    D --> E["Harness 装配<br/>bootstrapHarness"]
```

这张图的阅读方式：箭头方向表示"覆盖"关系——右侧来源先加载，左侧来源后到且胜出。具体实现分两处完成：模型引用在 `bootstrapHarness` 内合并（CLI 解析出的 `modelRef` 优先于文件中的 `provider`/`model`），而权限模式则在装配完成后通过 `applyPermissionMode` 单独覆写。这一职责拆分的原因是权限管理器需要持有可变的运行时状态，无法在构造时一锤定音。

Sources: [commands.ts](src/cli/commands.ts#L56-L83)、[bootstrap.ts](src/bootstrap.ts#L77-L85)、[args.ts](src/cli/args.ts#L50-L68)

## config.json：项目级、可提交的配置文件

配置文件位于项目根目录下的 `.tinycode/config.json`，**所有字段都是可选的**——文件不存在是完全正常的状态（测试验证了这一点：无文件时返回空配置且零警告）。文件缺失静默跳过，但文件存在却读不了（比如 JSON 写坏了）会产生非致命警告，程序继续以默认值运行。

字段全貌如下表所示：

| 字段 | 类型 | 作用 | 未设置时的默认值 |
|---|---|---|---|
| `provider` | 字符串 | 提供商名，如 `"anthropic"` | 由解析链自动选择 |
| `model` | 字符串 | 模型 ID | 自动挑选第一个已认证的模型 |
| `maxOutputTokens` | 正整数（≤200000） | 限制单次请求输出 token，规避预付额度预检 | 16384 |
| `permissionMode` | `"ask"` 或 `"auto"` | 审批模式 | `"ask"` |
| `context.compactAboveTokens` | 正整数 | 触发自动压缩的软预算 | 上下文窗口 × 0.8 |
| `context.keepRecentMessages` | 整数（≥2） | 压缩时逐字保留的近期消息数 | 12 |
| `context.maxToolResultChars` | 正整数 | 转录中单条工具结果的最大字符数 | 30000 |
| `mcpServers` | 对象映射 | stdio MCP 服务器定义 | 不连接任何服务器 |

一个典型的完整配置长这样：

```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-haiku-4.5",
  "maxOutputTokens": 16384,
  "permissionMode": "ask",
  "context": { "compactAboveTokens": 80000, "keepRecentMessages": 12 },
  "mcpServers": {
    "example": { "command": "node", "args": ["server.js"] }
  }
}
```

注意 `provider` 和 `model` 是两个独立字段而非斜杠字符串；斜杠写法（`openai/gpt-5`）只出现在环境变量和 CLI 标志中，由 `parseModelRef` 函数负责拆分。

Sources: [schema.ts](src/config/schema.ts#L16-L34)、[loader.ts](src/config/loader.ts#L66-L94)、[README.md](README.md#L136-L154)、[bootstrap.ts](src/bootstrap.ts#L91-L98)

**校验失败的语义值得单独强调**：配置解析用的是 Zod 的 `safeParse`，一旦失败，整个配置对象回退为空 `{}` 并打印带路径的警告信息——例如把 `permissionMode` 写成 `"sometimes"` 会得到警告而不是崩溃。这是一种"宁可保守也不中断"的设计：坏掉的配置不会让代理带着错误参数悄悄跑起来，也不会阻止你打开 TUI 去修复它。每个 `mcpServers` 条目自身还有一层子 schema，约束 `command` 必填、`timeoutMs` 上限 120 秒等。

Sources: [schema.ts](src/config/schema.ts#L7-L14)、[loader.ts](src/config/loader.ts#L81-L88)、[config.test.ts](tests/config.test.ts#L42-L47)

## 环境变量：运行时覆盖与密钥注入通道

环境变量承担两类完全不同的职责——**行为覆盖**和**凭据注入**。前者由 TinyCode 自己读取，后者则完全交给底层的 pi-ai 提供商库。

| 环境变量 | 取值示例 | 作用 | 覆盖目标 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` 等 | `sk-ant-…` | 提供商凭据（pi-ai 库读取） | 无对应文件字段（刻意设计） |
| `TINYCODE_MODEL` | `openai/gpt-5` 或 `mock` | 默认模型，支持 `provider/model` 斜杠语法 | `provider` + `model` |
| `TINYCODE_PERMISSION_MODE` | `ask` / `auto` | 默认审批模式 | `permissionMode` |
| `TINYCODE_HOME` | `/tmp/tc-home` | 数据目录重定向（会话与工件存储位置） | 无文件字段 |

`TINYCODE_MODEL` 的解析有一个容易踩坑的细节：只有包含斜杠时才会同时覆盖 `provider` 和 `model`，否则仅覆盖 `model`。另一个细节是 **`mock` 是保留值**——当它等于 `mock` 时加载器会直接忽略这个变量，因为 mock 模式的启用逻辑位于 bootstrap 层（检查 `process.env.TINYCODE_MODEL === "mock"`），如果让加载器把它当作真实模型写进配置，反而会污染正常的模型解析链。测试专门锁定了这个行为。

Sources: [loader.ts](src/config/loader.ts#L96-L107)、[bootstrap.ts](src/bootstrap.ts#L73-L76)、[registry.ts](src/model/registry.ts#L23-L30)、[config.test.ts](tests/config.test.ts#L49-L61)、[config.test.ts](tests/config.test.ts#L85-L90)

关于凭据注入：TinyCode 自身的代码从不接触 API 密钥。`ModelRegistry` 构造时注册 pi-ai 的全部内置提供商，这些提供商各自从标准命名的环境变量（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GROQ_API_KEY`……）读取凭据。当你不指定模型时，注册表的解析链会自动挑选**第一个已完成认证配置**的模型；如果所有提供商都没有密钥，抛出的 `ModelNotConfiguredError` 会给出三条可操作的出路：设置某个 `*_API_KEY`、在 config.json 里指定模型、或用 `TINYCODE_MODEL=mock` 走离线脚本模式。

交互式 TUI 还有一层额外宽容：没有配置任何密钥时不拒绝启动，而是自动降级到 mock 模型并在界面里展示引导提示（onboarding notice），告诉你如何接入真实提供商。mock 模型的默认回复文案本身就是一份配置指南。

Sources: [registry.ts](src/model/registry.ts#L101-L114)、[registry.ts](src/model/registry.ts#L48-L66)、[index.ts](src/cli/index.ts#L45-L69)

`TINYCODE_HOME` 则服务于另一个正交的关注点：它是用户级数据目录（会话记录、工具结果工件都存放在其下的 `sessions/` 子目录），默认指向 `~/.tinycode`。重定向它的动机写在函数文档里——测试期间把数据写到临时目录，确保开发和 CI 永远不会污染真实主目录。

Sources: [loader.ts](src/config/loader.ts#L6-L16)

## 密钥安全管理：四道防线为何层层设防

这是整个配置体系中最能体现设计意图的部分。问题背景很现实：开发者经常顺手把 API 密钥粘进配置文件，而 TinyCode 的 config.json **定位为可提交进版本库的文件**——两者相遇就是一次密钥泄露事故。防御不是靠单一机制，而是四个互相独立的层次。

```mermaid
flowchart TD
    A["开发者误将密钥写入 config.json"] --> B{"防线 1：Schema 刻意不收录<br/>任何密钥类字段"}
    B -->|"密钥成为未知字段"| C{"防线 2：启动时正则扫描<br/>SECRET_FIELD_RE"}
    C -->|"命中密钥样式的键名或 sk- 开头的值"| D["防线 3：打印醒目警告<br/>（非致命，其余配置照常生效）"]
    C -->|"未触发扫描"| E["防线 4：.gitignore 兜底<br/>排除 .env* / *.key / *.pem / *.local.json"]
    D --> E
```

先看图中最上游的一道防线：`configSchema` 里**根本不存在**存放密钥的位置，这不是遗漏而是注释明言的刻意设计——"密钥只能来自环境变量"。由于 Zod 校验对多余字段宽容，误写的密钥不会导致报错，于是有了第二道防线：每次加载配置时，先用正则 `^(.*(?:api[_-]?key|apikey|secret|token|password|credential).*|sk-.*)$` 递归扫描整棵 JSON 树，匹配两类特征——**形似密钥的字段名**（如 `apiKey`、`my-secret`），以及**值以 `sk-` 开头的字符串**（即使字段名叫 `note` 也逃不掉，有专门测试覆盖这种嵌套隐藏场景）。命中后打印的警告直白地说明风险：这个文件可能会被提交，请移除其中的秘密。

Sources: [loader.ts](src/config/loader.ts#L32-L53)、[loader.ts](src/config/loader.ts#L74-L80)、[config.test.ts](tests/config.test.ts#L63-L83)、[registry.ts](src/model/registry.ts#L26-L29)

第三道防线的取舍值得初学者留意：扫描命中**只警告不拒绝加载**。这是一个深思熟虑的折中——如果直接拒绝启动，一个无关紧要的误报（比如字段名碰巧含 `token` 一词的非敏感配置）就会把整个工具锁死；而警告既保住了可用性，又确保泄露者几乎不可能错过提示。仓库根目录的 `.gitignore` 则构成最后一道静态防线，把 `.env`、`.env.*`、`*.pem`、`*.key` 和 `.tinycode/*.local.json` 全部排除在提交之外——后者为你提供了 config.json 之外的本地私有配置逃生舱。

Sources: [loader.ts](src/config/loader.ts#L55-L59)、[.gitignore](.gitignore#L7-L12)、[README.md](README.md#L156-L168)

日常实践中请遵守下表的分工：

| 应该放进 config.json | 只应放进环境变量 |
|---|---|
| `provider` / `model` 选择 | `ANTHROPIC_API_KEY` 等一切凭据 |
| `permissionMode`、`context.*` 调优参数 | 个人机器特有的路径覆盖 |
| `mcpServers` 团队共享定义 | `TINYCODE_HOME` 等本机重定向 |
| `maxOutputTokens` 预算上限 | —— |

## 动手实践：五分钟接入真实模型

把前面的知识串成一条操作路径。假设你要用 Anthropic 的模型：

1. 在 shell 配置文件（如 `~/.zshrc`）中导出密钥并重启终端：`export ANTHROPIC_API_KEY=sk-ant-…`
2. 运行 `tinycode --list-models` 验证凭据已被识别——该命令只列出已完成认证配置的模型，列表为空说明环境变量没生效。
3. （可选）在项目里创建 `.tinycode/config.json` 固定模型选择，避免依赖"第一个可用模型"的隐式规则。
4. 直接运行 `tinycode` 进入 TUI，状态栏确认当前模型。

```mermaid
flowchart LR
    S["导出 API_KEY"] --> T["tinycode --list-models"]
    T -->|"列表为空"| S
    T -->|"看到目标模型"| U["可选：写入 config.json 固定模型"]
    U --> V["tinycode 启动 TUI"]
    T -->|"不想配密钥"| W["TINYCODE_MODEL=mock<br/>离线零配置体验"]
```

临时切换场景不必改文件：`tinycode -m openai/gpt-5 --perm auto` 用 CLI 标志完成一次性覆盖，这正是优先级链顶层存在的意义。若遇到问题，对照下表排查：

| 症状 | 最可能原因 | 处理方式 |
|---|---|---|
| 启动即报"No API key found" | 环境变量未导出或未重启终端 | 重新 export 后用 `--list-models` 验证 |
| 报 `Unknown model "x/y"` | config.json 或标志里的模型 ID 拼写错误 | 用 `--list-models` 对照精确 ID |
| 启动打印 "look like API keys" 警告 | 密钥被误写进了 config.json | 把该字段删除，改用环境变量 |
| 配置改动完全不生效 | JSON 语法错误导致整体回退为空配置 | 查看启动时的 `Invalid …config.json` 警告 |
| 会话文件出现在意外位置 | `TINYCODE_HOME` 残留了旧值 | 检查该变量当前指向 |

## 本页要点回顾与本节后续

配置体系的三条主线：**优先级链**（标志 > 环境 > 文件 > 默认值）、**容错语义**(缺失静默、损坏告警不崩溃、校验失败整体回退)、**密钥隔离**(schema 排除 + 扫描告警 + gitignore 兜底)。掌握了这些，你已经能安全地为任何项目配置 TinyCode。

接下来建议按目录顺序继续阅读：

- [交互式 TUI 使用指南：快捷键、输入与斜杠命令](4-jiao-hu-shi-tui-shi-yong-zhi-nan-kuai-jie-jian-shu-ru-yu-xie-gang-ming-ling)——本页配置的 `permissionMode` 在界面中的实际体验
- [一次性模式（-p）：无头运行与权限默认拒绝语义](5-ci-xing-mo-shi-p-wu-tou-yun-xing-yu-quan-xian-mo-ren-ju-jue-yu-yi)——无头模式下配置的特殊化处理
- [模型注册表：多提供商选择链与 Mock 模型注入](25-mo-xing-zhu-ce-biao-duo-ti-gong-shang-xuan-ze-lian-yu-mock-mo-xing-zhu-ru)——深入 `resolve()` 背后的选择算法