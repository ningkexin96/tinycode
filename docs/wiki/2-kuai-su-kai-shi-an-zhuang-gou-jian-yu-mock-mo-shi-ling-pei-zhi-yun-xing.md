本页是动手实践篇：从克隆仓库到第一次看到 TinyCode 的终端界面，全程不需要任何 API 密钥。我们将依次走完**环境准备 → 安装依赖 → 构建 → 以 Mock 模式启动 → 冒烟验证**五个步骤，并解释每一步背后实际执行的代码。如果你还没读过项目定位，建议先看[项目概览：一个可以一下午读完的编码智能体骨架](1-xiang-mu-gai-lan-ge-ke-yi-xia-wu-du-wan-de-bian-ma-zhi-neng-ti-gu-jia)。

## 环境要求：只需要一个足够新的 Node.js

TinyCode 对环境的全部硬性要求写在 `package.json` 的 `engines` 字段里：Node.js **≥ 22.19**。之所以要求这么新的版本，是因为整个项目是纯 ESM 包且大量使用 Node 原生能力（如 `node:fs`、顶层 `await`）。除此之外没有数据库、没有 Docker、没有任何外部服务——运行阶段甚至不需要网络。

| 项目 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22.19 | `engines` 字段强制约束，CI 在 Node 22 与 24 双版本上验证 |
| 包管理器 | npm | 仓库自带 `package-lock.json` 锁定依赖版本 |
| 网络 | 仅 `npm install` 时需要 | 运行、测试均可完全离线（Mock 模型驱动） |
| API 密钥 | 可选 | 没有密钥也能启动（见下文 Mock 模式） |

CI 工作流在 Ubuntu 上用矩阵策略同时跑 Node 22 和 Node 24，这意味着官方支持的最低与推荐版本都经过实测。

Sources: [package.json](package.json#L7-L9), [.github/workflows/ci.yml](.github/workflows/ci.yml#L12-L15)

## 安装：一条命令，两个已知坑

```bash
git clone https://github.com/helsome/tinycode.git
cd tinycode
npm install
```

依赖非常克制：运行时依赖只有 Pi 三件套（`pi-agent-core`、`pi-ai`、`pi-tui`）、MCP SDK 和 zod 五个包，其余全是开发工具（TypeScript、tsx、vitest、eslint、node-pty 等）。

有一个在特定 npm 版本上会遇到的坑值得提前知道：部分 npm 版本会拦截依赖的安装脚本，而 `esbuild`（tsx 和 vitest 底层需要它绑定平台二进制）和 `node-pty`（原生模块，用于 PTY 级 TUI 测试）都依赖 postinstall 步骤。如果安装后运行报二进制相关错误，执行 CI 中同款的修复命令即可：

```bash
npm rebuild esbuild && npm rebuild node-pty
```

Sources: [package.json](package.json#L21-L40), [.github/workflows/ci.yml](.github/workflows/ci.yml#L24-L29)

## 构建：TypeScript 源码如何变成 `dist/`

```bash
npm run build    # 等价于 tsc -p tsconfig.build.json
```

这条命令把 `src/` 下的 TypeScript 源码编译进 `dist/` 目录，并保留 source map。编译配置很朴素：`outDir: "dist"`、`rootDir: "src"`，不生成声明文件。构建完成后，`dist/cli/index.js` 就是可执行入口——`package.json` 的 `bin` 字段把 `tinycode` 命令映射到这个文件，所以你也可以通过 `npm link` 在全局获得 `tinycode` 命令。

日常开发其实不必每次构建：`npm run dev` 用 tsx 直接运行 TypeScript 源码，跳过编译步骤。两种方式的取舍如下：

| 启动方式 | 命令 | 是否需要先 build | 适用场景 |
|---|---|---|---|
| 开发直跑 | `npm run dev` | 否（tsx 即时转译） | 改代码后立即验证 |
| 构建产物 | `node dist/cli/index.js` | 是 | 模拟真实安装后的行为、CI 冒烟 |
| 全局命令 | `npm link` 后使用 `tinycode` | 是 | 把它当作日常工具长期使用 |

其余脚本一并列出备查：`typecheck`（严格类型检查，不产出文件）、`lint`（eslint）、`test`（vitest 全量离线测试）与 `test:watch`。

Sources: [package.json](package.json#L13-L20), [tsconfig.build.json](tsconfig.build.json#L1-L10), [.github/workflows/ci.yml](.github/workflows/ci.yml#L31-L41)

## 零配置运行：Mock 模式的三条触发路径

现在到了本页的核心问题：**没有 API 密钥，这个编码智能体怎么跑起来？**

答案是 Mock 模型注入。`ModelRegistry.enableMock()` 会向提供商注册表中加入一个确定性的"faux provider"，模型 id 为 `tinycode-mock`。它不联网、不花钱，收到任何请求都返回预先编排好的回复——默认回复是一段友好的引导文案，告诉你如何配置真实提供商。这意味着完整的代理循环（流式响应、工具调用、会话持久化）都能真实运转，只是"大脑"是脚本化的。

触发 Mock 有三条互不冲突的路径：

| 触发方式 | 写法 | 生效机制 | 典型场景 |
|---|---|---|---|
| 显式标志 | `--mock` | 参数解析器置位 `args.mock`，传入 harness 构建 | 演示、复现问题 |
| 环境变量 | `TINYCODE_MODEL=mock` | bootstrap 装配时直接读取该变量；配置加载器会特意跳过 `"mock"` 这个值，不把它当作真实的 provider/model 解析 | CI 冒烟、临时切离线 |
| 自动回退 | 什么都不配，直接启动交互界面 | 捕获 `ModelNotConfiguredError` 后以 `mock: true` 重建 harness，并把错误信息作为引导面板传给 TUI | 克隆后第一次随手运行 |

第三条路径是"零配置"体验的关键设计：交互式 TUI 在捕获"找不到任何可用密钥"的错误后，**不会拒绝启动**，而是自动切换到 Mock 模式并在界面上展示引导面板，告诉你确切的下一步（导出某个密钥 → 重启）。

下面的流程图概括了启动时的完整决策流（阅读前提：了解 CLI 参数、配置文件与环境变量三个来源即可，无需其他背景）：

```mermaid
flowchart TD
    A["tinycode 启动"] --> B{"解析命令行参数"}
    B -->|"--help / --version"| C["打印信息并退出"]
    B -->|"-p 'prompt'"| D["无头一次性模式"]
    B -->|"默认"| E["交互式 TUI"]
    D --> F["加载 .tinycode/config.json<br>再叠加环境变量覆盖"]
    E --> F
    F --> G{"--mock 标志或<br/>TINYCODE_MODEL=mock ?"}
    G -->|"是"| H["enableMock():<br>注册脚本化 Mock 模型"]
    G -->|"否"| I["resolve(): 按引用查找<br>或选第一个已认证的模型"]
    I -->|"成功"| J["正常启动"]
    I -->|"抛出<br>ModelNotConfiguredError"| K{"当前是交互模式?"}
    K -->|"是"| H
    K -->|"否（-p 无头）"| L["打印带指引的错误<br>退出码 1"]
    H --> M["进入代理循环<br>所有回复来自本地脚本"]
```

注意流程图右下角的分叉：**自动回退只发生在交互模式**。`-p` 无头模式没有对话界面来承载引导面板，所以它会诚实地失败，并把修复建议打印到 stderr——错误信息本身列出了三种出路（设某个密钥、写 config.json、用 `TINYCODE_MODEL=mock`）。

Sources: [src/model/registry.ts](src/model/registry.ts#L48-L66), [src/model/registry.ts](src/model/registry.ts#L108-L113), [src/bootstrap.ts](src/bootstrap.ts#L73-L81), [src/config/loader.ts](src/config/loader.ts#L96-L106), [src/cli/index.ts](src/cli/index.ts#L45-L79), [src/cli/args.ts](src/cli/args.ts#L66-L68), [src/cli/commands.ts](src/cli/commands.ts#L47-L54)

## 动手验证：四条冒烟命令

装好之后不必凭感觉确认"应该能用了"，以下命令逐一验证各环节，最后两条正是 CI 流水线每天在跑的冒烟检查：

```bash
node dist/cli/index.js --version
# 期望输出：tinycode 1.0.0

node dist/cli/index.js --help
# 期望输出：完整用法说明，包括选项、环境变量与项目文件约定

TINYCODE_MODEL=mock node dist/cli/index.js -p "hello"
# 期望输出：[TinyCode mock model] No real provider is configured.
#          Set ANTHROPIC_API_KEY / OPENAI_API_KEY ...
#          or choose a model in .tinycode/config.json to talk to a real LLM.

TINYCODE_MODEL=mock node dist/cli/index.js --list-models
# 列出当前有凭据的模型；无凭据时会提示设置密钥或改用 mock
```

第三条命令特别值得玩味：它让**真实的代理循环**处理了一个 prompt，只是响应由 Mock 模型的默认脚本提供。CI 断言输出包含 `"TinyCode mock model"` 字样，这证明从参数解析 → 配置加载 → Mock 注入 → 模型解析 → 无头运行的整条流水线是通的。

Sources: [.github/workflows/ci.yml](.github/workflows/ci.yml#L43-L47), [src/model/registry.ts](src/model/registry.ts#L57-L64), [src/cli/index.ts](src/cli/index.ts#L149-L168), [src/cli/commands.ts](src/cli/commands.ts#L42-L44)

## 启动时究竟装配了什么：一次 Harness 组装之旅

理解了"怎么跑"，再看"跑起来之后发生了什么"。无论交互还是无头模式，入口最终都会调用同一个装配函数 `bootstrapHarness`，把散落的子系统组装成完整的 Harness。下图是简化后的装配关系（阅读前提：知道"代理循环需要一个模型、一组工具和一套权限规则"即可）：

```mermaid
flowchart LR
    subgraph Inputs["三个输入来源（优先级从高到低）"]
        direction TB
        FLAGS["CLI 标志<br>--model / --permission-mode / --mock"]
        ENV["环境变量<br>TINYCODE_MODEL / TINYCODE_PERMISSION_MODE"]
        FILE[".tinycode/config.json"]
    end

    Inputs --> BOOT["bootstrapHarness"]

    BOOT --> MR["ModelRegistry<br>内置全部提供商目录<br>可选注入 Mock"]
    BOOT --> PM["PermissionManager<br>默认 ask 模式"]
    BOOT --> TR["ToolRegistry<br>7 个内置工具 + load_skill<br>+ 4 个子代理工具"]
    BOOT --> SR["SkillRegistry<br>渐进披露的技能发现"]
    BOOT --> MM["McpManager（可选）<br>stdio 服务器并行连接"]
    BOOT --> SM["SessionManager（交互必有）"]

    MR --> RT["TinyCodeRuntime<br>+ ContextManager + 系统提示词"]
    PM --> RT
    TR --> RT
    SR --> RT
    MM --> RT
    SM --> RT

    RT --> OUT["TuiApp（交互）<br>或 stdout 最终答案（-p）"]
```

几个对新手有用的细节：模型解析的输出 token 默认封顶在 16384（避免预付费平台的余额预检报错）；上下文压缩阈值默认取模型上下文窗口的 80%；MCP 服务器的连接失败只记录、不致命；交互模式的每次启动都会创建一个新会话，持久化到用户主目录下的 `~/.tinycode/sessions/`（可用 `TINYCODE_HOME` 重定向，CI 测试就是这么隔离数据的）。

Sources: [src/cli/commands.ts](src/cli/commands.ts#L56-L83), [src/bootstrap.ts](src/bootstrap.ts#L66-L176), [src/config/loader.ts](src/config/loader.ts#L6-L16)

## 常见问题排查

初学者在这一步最常遇到的问题及处置方法：

| 现象 | 原因 | 处理方式 |
|---|---|---|
| `-p` 模式报 "No API key found..." 并以退出码 1 结束 | 无头模式没有界面承载引导面板，不会自动回退 Mock | 加 `TINYCODE_MODEL=mock`，或配置任一提供商密钥 |
| `npm install` 后 tsx/vitest 报平台二进制错误 | 安装脚本被 npm 版本拦截，esbuild 未绑定平台二进制 | `npm rebuild esbuild && npm rebuild node-pty` |
| 报 `Unknown model "x/y"` | 指定的 provider/model 不在内置目录中 | 先跑 `--list-models` 看有哪些已认证模型 |
| `npm run dev` 直接语法报错 | Node 版本低于 22.19，不支持所用特性 | 升级到 Node 22 LTS 或 24（CI 实测的两个版本） |
| 交互界面出现引导面板而非正常对话 | 这是特性：无密钥时自动进入 Mock 模式 | 按面板指引 export 密钥后重启即接通真实模型 |

Sources: [src/cli/commands.ts](src/cli/commands.ts#L8-L40), [src/model/registry.ts](src/model/registry.ts#L86-L89), [.github/workflows/ci.yml](.github/workflows/ci.yml#L24-L29)

## 下一步去哪里

到这里你已经拥有一个能完整运转的编码智能体骨架。推荐的深入顺序：

1. **想让它连上真实的大脑** → [配置体系：config.json、环境变量与密钥安全管理](3-pei-zhi-ti-xi-config-json-huan-jing-bian-liang-yu-mi-yao-an-quan-guan-li)，弄清"标志 > 环境变量 > 文件"的三级优先级；
2. **想先在终端里玩起来** → [交互式 TUI 使用指南：快捷键、输入与斜杠命令](4-jiao-hu-shi-tui-shi-yong-zhi-nan-kuai-jie-jian-shu-ru-yu-xie-gang-ming-ling)；
3. **想在脚本里无人值守地跑** → [一次性模式（-p）：无头运行与权限默认拒绝语义](5-ci-xing-mo-shi-p-wu-tou-yun-xing-yu-quan-xian-mo-ren-ju-jue-yu-yi)，重点理解 ASK 操作为何默认被拒；
4. **想搞懂 Mock 模型的全部能力**（比如测试中如何给它编排多轮脚本）→ [模型注册表：多提供商选择链与 Mock 模型注入](25-mo-xing-zhu-ce-biao-duo-ti-gong-shang-xuan-ze-lian-yu-mock-mo-xing-zhu-ru)。