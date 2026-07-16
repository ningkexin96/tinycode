技能系统是 TinyCode 扩展机制的第一个支柱：项目维护者将领域指令写成 `.tinycode/skills/<name>/SKILL.md` 文件，系统在启动时扫描这些文件，但只把每个技能的**名称与描述**（各占一行）注入系统提示词；完整的 Markdown 指令正文则在模型通过 `load_skill` 工具显式调用时才进入上下文。本文剖析这一"渐进式披露"设计的完整实现——文件解析、双层发现、注册表管理、工具封装与装配链路。

## 设计动机：为什么需要渐进式披露

如果把所有技能的完整正文都塞进系统提示词，上下文成本会随技能数量和正文长度线性膨胀，而其中大部分内容对当前任务毫无用处。TinyCode 的解法是把"知道有哪些技能"与"知道技能内容是什么"拆成两个阶段：

```mermaid
sequenceDiagram
    participant B as bootstrap 启动器
    participant R as SkillRegistry
    participant P as 系统提示词
    participant M as 模型
    participant T as load_skill 工具

    B->>R: discover(projectRoot)
    R-->>B: Skill[] 完整对象（含 body）
    B->>P: skills.summary() 仅 name + description
    Note over P: 每个技能仅消耗约一行 Token
    M->>T: execute({ name: "code-review" })
    T->>R: get(name)
    R-->>T: 完整 body
    T-->>M: "# Skill: code-review … 全文"
    Note over M,T: 正文仅在匹配任务时才占用上下文
```

这一设计使提示词中的技能索引成本是 **O(技能数)** 的常数项，而正文的 **O(正文字符数)** 成本只在真正需要时支付。源码注释直接点明了意图："only name/description enter the system prompt; full bodies are loaded on demand through the load_skill tool"。

Sources: [registry.ts](src/skills/registry.ts#L7-L11)、[prompt.ts](src/agent/prompt.ts#L54-L62)

## SKILL.md 文件契约与容错解析

一个技能就是一个目录加一个 Markdown 文件。数据契约由 `Skill` 接口定义：`name`、`description` 来自 YAML 风格的前置元数据块，`body` 是前置块之后的全部正文，`path` 记录来源文件以便溯源。

| 字段 | 来源 | 缺省回退 |
|------|------|----------|
| `name` | frontmatter 的 `name:` 键 | 所在目录名（`path.basename(path.dirname(...))`） |
| `description` | frontmatter 的 `description:` 键 | 空字符串 |
| `body` | `---` 分隔线之后的 Markdown | 无前置块时为整个文件内容 |
| `path` | SKILL.md 绝对路径 | — |

解析器 `parseFrontmatter` 用一条正则 `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/` 切分前置块与正文，然后逐行以**第一个冒号**为界拆出键值——这意味着描述文本中即使包含冒号也不会被截断。整个解析层贯彻了防御式风格：文件不可读时 `loadSkillFile` 返回 `undefined` 而非抛异常；目录不存在时 `discoverSkills` 返回空数组；没有前置块的纯文本文件也能被当作合法技能（整篇即正文）。此外 `discoverSkills` 只收录 `body.length > 0` 的技能，空壳目录会被静默过滤。

仓库自带的 fixture 展示了一个标准技能的样子——frontmatter 声明名称与描述，正文给出可执行的审查步骤：

```markdown
---
name: code-review
description: Review code changes for correctness and maintainability.
---

# Code Review Skill

When asked to review code:
1. Read the changed files fully before commenting.
...
```

Sources: [loader.ts](src/skills/loader.ts#L9-L15)、[loader.ts](src/skills/loader.ts#L17-L30)、[loader.ts](src/skills/loader.ts#L32-L47)、[loader.ts](src/skills/loader.ts#L49-L64)、[SKILL.md](fixtures/sample-project/.tinycode/skills/code-review/SKILL.md#L1-L7)

## 双层发现机制与项目优先级

`SkillRegistry.discover(projectRoot)` 从两个根目录收集技能：用户级的 `~/.tinycode/skills` 与项目级的 `<projectRoot>/.tinycode/skills`。合并语义依赖 JavaScript 对象展开的顺序——用户技能先入 `Map`，项目技能后入并覆盖同名键，因此**项目级定义总是胜出**：

```mermaid
flowchart LR
    A["~/.tinycode/skills<br/>用户级全局技能"] --> C{"Map 合并<br/>同名键后者覆盖"}
    B["&lt;project&gt;/.tinycode/skills<br/>项目级技能"] --> C
    C --> D["skills Map<br/>项目优先"]
    D --> E["summary() → 系统提示词索引"]
    D --> F["get(name) ← load_skill 工具"]
```

注意 `discover` 开头会先 `this.skills.clear()`——每次调用都是全量重建而非增量累积，保证了重复调用（例如测试或未来热重载场景）不会产生幽灵条目。CLI 帮助文本也将 `.tinycode/skills/*/SKILL.md` 作为公开契约列出，说明这是面向用户的稳定约定而非内部实现细节。

| 维度 | 用户级目录 | 项目级目录 |
|------|-----------|-----------|
| 路径 | `~/.tinycode/skills` | `<projectRoot>/.tinycode/skills` |
| 典型用途 | 个人通用工作流 | 团队共享的领域指令（随仓库提交） |
| 冲突时优先级 | 低（先插入） | 高（后插入覆盖） |

Sources: [registry.ts](src/skills/registry.ts#L15-L23)、[registry.ts](src/skills/registry.ts#L25-L39)、[commands.ts](src/cli/commands.ts#L34-L37)

## load_skill 工具：按需注入完整指令

`createLoadSkillTool(registry)` 是一个工厂函数，产出符合 Pi 运行时 `AgentTool` 契约的统一工具。参数模式只有一个 `name` 字符串；`execute` 的行为分两条路径：

- **命中**：返回格式化的文本块——`# Skill: <name>` 标题、来源路径、完整正文——并在 `details` 中附上 `{ skill: name }` 供 UI 层或测试做结构化断言；
- **未命中**：不返回静默失败，而是抛出带**可用技能清单**的错误——有技能时报 `Unknown skill "x". Available skills: a, b`，一个都没有时报 `No skills are installed.`。

第二条路径是一个精巧的自愈设计：模型拼错技能名时，错误信息本身就携带了正确答案，下一轮循环即可自行纠正，无需人工介入。测试用例 `lists available skills when the name is unknown` 明确锁定了这一契约。

Sources: [registry.ts](src/skills/registry.ts#L42-L53)、[registry.ts](src/skills/registry.ts#L54-L72)、[skills.test.ts](tests/skills.test.ts#L66-L71)

## 装配链路：从 bootstrap 到系统提示词

技能系统的接线发生在 `bootstrap.ts` 的三个位置，且顺序经过刻意安排——工具注册必须先于提示词构建吗？实际上两者互不依赖，真正的约束是**两者都必须在 `TinyCodeRuntime` 构造之前完成**：

```mermaid
flowchart TD
    S1["new SkillRegistry()<br/>skills.discover(projectRoot)<br/>bootstrap L100-102"] --> S2["tools.register(createLoadSkillTool(skills))<br/>bootstrap L128"]
    S1 --> S3["buildSystemPrompt({... skills: skills.summary()})<br/>bootstrap L155-162"]
    S2 --> S4["new TinyCodeRuntime({... tools ...})"]
    S3 --> S4
    S4 --> H["harness.skills 暴露给 CLI/TUI 层"]
```

系统提示词构建侧，`buildSystemPrompt` 仅当 `input.skills` 非空时追加一个 `## Skills` 区段，内容为 `- <name>: <description>` 的列表，并附带一句引导语 "Detailed instruction packages available via the load_skill tool:"——这句话就是渐进式披露的**协议声明**：告诉模型索引之外还有全文可取，以及取用的工具名。若项目中没有任何技能，该区段整体消失，提示词保持零噪音。

最后 `harness.skills` 被放入返回的装配体，供 CLI 与 TUI 层做展示用途，形成"运行时消费 summary、交互层消费 list"的双通道。

Sources: [bootstrap.ts](src/bootstrap.ts#L100-L102)、[bootstrap.ts](src/bootstrap.ts#L115-L128)、[bootstrap.ts](src/bootstrap.ts#L155-L176)、[bootstrap.ts](src/bootstrap.ts#L186-L198)、[prompt.ts](src/agent/prompt.ts#L13-L18)、[prompt.ts](src/agent/prompt.ts#L44-L62)

## 可观测性与边界：斜杠命令与子代理隔离

用户可以在 TUI 中用 `/skills` 斜杠命令查看当前发现的技能列表（含无描述时的 `(no description)` 占位），状态栏摘要也会显示技能计数。这提供了不依赖模型的直接观测面——配置是否生效一眼可见。

一个重要的架构边界：**子代理不接入技能系统**。bootstrap 中主代理的工具集包含 `load_skill`，但子代理工作线程的 `workerTools` 仅由 read/grep/find/ls 四个只读工具构成。这与子代理的整体定位一致——它们是被监督的一次性执行单元，不需要自主加载长指令的能力（相关设计见 [子代理监督：只读工作线程、并发上限与结构化报告回收](23-zi-dai-li-jian-du-zhi-du-gong-zuo-xian-cheng-bing-fa-shang-xian-yu-jie-gou-hua-bao-gao-hui-shou)）。

Sources: [slash.ts](src/tui/slash.ts#L110-L117)、[slash.ts](src/tui/slash.ts#L150)、[bootstrap.ts](src/bootstrap.ts#L130-L144)

## 行为契约验证：测试覆盖矩阵

`tests/skills.test.ts` 以四个 describe 块覆盖了系统的每一层，且全部基于 `fixtures/sample-project` 真实文件而非内联字符串，验证了解析器对实际文件布局的兼容性：

| 测试组 | 验证的契约 | 关键断言 |
|--------|-----------|----------|
| `frontmatter parsing` | 键值提取、正文切分、无前置块容错 | `meta.name === "review"`；纯文本输入 `meta === {}` |
| `skill discovery` | fixture 发现、缺失目录返回空、不可读文件返回 undefined | 发现 `code-review` 且正文含步骤文本 |
| `SkillRegistry` | 项目根发现 + 按需读取 | `summary()` 只含 name/description；未知名返回 undefined |
| `load_skill tool` | 命中返回全文 + details；未命中报可用清单 | `details.skill === "code-review"`；rejects 匹配 `/Available skills: code-review/` |

值得注意的是测试同时锁定了**成功路径与降级路径**：`returns empty for missing directories` 和 `loadSkillFile tolerates unreadable paths` 确保了防御式解析不是偶然实现而是被守护的行为契约。这套单测属于全离线测试策略的一部分，无需任何网络或真实模型即可运行（策略总览见 [全离线测试策略：脚本化 Mock 模型驱动真实代理循环的 E2E](26-quan-chi-xian-ce-shi-ce-lue-jiao-ben-hua-mock-mo-xing-qu-dong-zhen-shi-dai-li-xun-huan-de-e2e)）。

Sources: [skills.test.ts](tests/skills.test.ts#L9-L22)、[skills.test.ts](tests/skills.test.ts#L24-L40)、[skills.test.ts](tests/skills.test.ts#L42-L53)、[skills.test.ts](tests/skills.test.ts#L55-L72)

## 小结与延伸阅读

技能系统以不到 140 行的源码实现了完整的渐进式披露：`loader.ts` 负责容错的文件解析，`registry.ts` 负责双层发现与工具封装，`prompt.ts` 注入一行式的技能索引，三者通过 bootstrap 的一条装配线串联。其核心权衡是用一次额外的工具调用往返换取提示词的长期瘦身——对于指令量大而命中率低的扩展场景，这笔交易显然划算。

建议按以下路径继续探索扩展机制的其他支柱：

- 工具如何进入统一命名空间：[统一工具注册表：内置、MCP 与子代理工具的命名空间合并](11-tong-gong-ju-zhu-ce-biao-nei-zhi-mcp-yu-zi-dai-li-gong-ju-de-ming-ming-kong-jian-he-bing)
- 装配线的全景视角：[Harness 装配流程：bootstrap 如何串联全部子系统](7-harness-zhuang-pei-liu-cheng-bootstrap-ru-he-chuan-lian-quan-bu-zi-xi-tong)
- 技能正文进入上下文后的预算管理：[Token 预算与自动压缩：会话摘要生成与保护窗口](18-token-yu-suan-yu-zi-dong-ya-suo-hui-hua-zhai-yao-sheng-cheng-yu-bao-hu-chuang-kou)
- `/skills` 命令的使用语境：[交互式 TUI 使用指南：快捷键、输入与斜杠命令](4-jiao-hu-shi-tui-shi-yong-zhi-nan-kuai-jie-jian-shu-ru-yu-xie-gang-ming-ling)