本页剖析 TinyCode 测试体系的最后一道防线：在**真实伪终端（PTY）中驱动的交互式 TUI 冒烟测试**，以及在 **Node 22/24 双版本矩阵上执行完整质量门禁的 CI 流水线**。前一页的 E2E 测试证明了"真实代理循环能修复坏项目"，而本页回答的是更底层的问题——*当用户真正打开一个终端、敲下键盘时，这个 TUI 是否还能干净地启动、响应与退出？*

## 质量门禁的分层结构

TinyCode 的测试体系呈现清晰的金字塔结构，每一层验证的对象粒度不同。组件级测试在进程内直接渲染 `TranscriptView`、`StatusBar` 并断言输出文本；E2E 测试用脚本化 Mock 模型驱动真实的代理循环；而 PTY 冒烟测试则把整个 CLI 作为**独立操作系统进程**启动，通过内核伪终端与之对话，验证从按键输入到进程退出码的全链路。

```mermaid
flowchart TD
    A["组件级测试<br/>tests/tui.test.ts"] -->|"进程内渲染视图<br/>断言纯文本输出"| B["集成/E2E 测试<br/>tests/harness.e2e.test.ts 等"]
    B -->|"Mock 模型驱动<br/>真实代理循环"| C["PTY 冒烟测试<br/>tests/tui.pty.test.ts"]
    C -->|"node-pty 启动<br/>dist/cli/index.js"| D["Node 22/24 CI 矩阵<br/>.github/workflows/ci.yml"]
    D -->|"typecheck → lint<br/>→ build → test → CLI smoke"| E["合并放行"]
```

这一分层意味着：即使所有进程内测试都通过，仍可能存在只有真实终端环境才能暴露的缺陷——括号粘贴模式的输入语义、斜杠命令自动补全菜单吞掉回车键、SIGINT 信号路径等。PTY 测试正是为这些"最后一厘米"问题而生。

Sources: [tui.test.ts](tests/tui.test.ts#L12-L51)、[README.md](README.md#L178-L187)

## PTY 冒烟测试的运行机制

测试文件开头的注释精确声明了它的使命："证明完整闭环在真实伪终端中成立：启动 CLI → 横幅渲染 → 键盘输入 → Mock 模型响应渲染 → 以退出码 0 干净退出（不挂起、无未捕获异常）"。整个测试装置由四个协作部件构成。

**构建产物驱动**是第一个关键决策——被测对象不是 TypeScript 源码经 tsx 转译后的内存模块，而是 `dist/cli/index.js` 这个真实构建产物。`beforeAll` 钩子在产物缺失时（例如全新克隆）现场执行一次 `npx tsc -p tsconfig.build.json`，保证后续断言针对用户实际运行的二进制。

**会话封装**方面，`spawnTui` 函数动态导入 `node-pty`，以 `xterm-256color` 终端类型、120×40 的行列尺寸、合并后的环境变量启动 `process.execPath` 执行 CLI。它返回一个 `Session` 对象：`output()` 提供累积的原始输出缓冲区（由 `onData` 事件持续追加），`exited` 是一个由 `onExit` 事件 resolve 的 Promise，携带退出码与信号。

**轮询等待**由 `waitFor(probe, timeoutMs, label)` 实现——每 100ms 探测一次条件，超时则抛出带标签的错误（如 `"PTY smoke timeout waiting for: startup banner"`），让失败原因一目了然。

**ANSI 净化**由 `stripAnsi` 完成，用一条正则同时剥除 CSI 序列（`\x1b[...字母`）和 OSC 序列（`\x1b]...\x07`），使得对人类可读文本（如 `"TinyCode v1.0"`）的断言不受光标控制码干扰。

Sources: [tui.pty.test.ts](tests/tui.pty.test.ts#L9-L22)、[tui.pty.test.ts](tests/tui.pty.test.ts#L24-L33)、[tui.pty.test.ts](tests/tui.pty.test.ts#L42-L74)、[tui.pty.test.ts](tests/tui.pty.test.ts#L37-L40)

## 为什么必须使用墙钟等待

文件注释中有一条重要的设计说明值得单独展开："被测对象是一个经由内核 PTY 驱动的独立操作系统进程，其时序无法用假计时器控制，因此条件必须基于真实输出轮询并设置硬性上限。"这与进程内测试形成根本分野——Vitest 的 `vi.useFakeTimers()` 可以瞬间推进进程内定时器，但对另一个 OS 进程毫无作用。因此这套装置选择了"轮询 + 天花板"策略：每个等待都有明确超时上限，且每条退出路径都额外用 `Promise.race` 挂载了一个挂起检测器（如 15 秒后抛出 `"TUI did not exit after /exit (lifecycle hang?)"`），将"进程不退出"这种静默故障转化为显式失败信息。检测器中的 `setTimeout(...).unref()` 还确保这些看门狗定时器不会阻止 Vitest 进程自身的正常收尾。

| 对比维度 | 进程内组件测试 | PTY 冒烟测试 |
|---|---|---|
| 被测对象 | 视图类的 `render()` 输出 | 构建产物 `dist/cli/index.js` |
| 时间控制 | 可用假计时器 | 必须墙钟轮询 |
| 输入方式 | 直接方法调用 | 字节写入内核 PTY |
| 失败模式 | 断言失败 | 挂起（需看门狗转译） |

Sources: [tui.pty.test.ts](tests/tui.pty.test.ts#L19-L21)、[tui.pty.test.ts](tests/tui.pty.test.ts#L127-L137)

## 与真实终端博弈的三个陷阱

第一条也是最完整的冒烟测试（单测超时 90 秒）串起了完整生命周期，途中绕过了三个只有在真实终端才会显现的交互陷阱，每一处都有注释解释缘由：

**括号粘贴模式**：输入 `"hello"` 后不能立即写 `"\r"`。编辑器启用了 bracketed-paste mode，一次组合写入会被识别为"粘贴插入"而非"提交按键"，所以必须先写字符、等编辑器回显后再单独发送回车。

**自动补全菜单吞噬回车**：发送 `"/exit"` 时，斜杠命令自动补全菜单处于激活状态，会拦截 Enter 键击。解法是先等 `/exit` 回显确认菜单已弹出，再写入 ESC 字节 `\x1b` 关闭菜单，停顿 150ms 后才发送最终的 `"\r"`。

**ISIG 终端的 Ctrl+C 语义**：第三条测试验证"空闲状态双击 Ctrl+C 退出"。由于 ISIG 终端会把 Ctrl+C 转换为 SIGINT 信号投递，测试直接调用 `session.term.kill("SIGINT")` 来精确复现这条路径，而非写入 `\x03` 字符。第一次 SIGINT 后等待界面出现 `"press ctrl+c again"` 提示，再发第二次，随后断言以退出码 0 干净退出。

```mermaid
sequenceDiagram
    participant T as 测试进程
    participant P as 内核 PTY
    participant C as dist/cli/index.js

    T->>P: pty.spawn(node, [cli], 120x40)
    P->>C: 启动子进程
    C-->>T: 横幅 "TinyCode v1.0"
    T->>P: write("hello")
    C-->>T: 编辑器回显 hello
    T->>P: write("\r") 单独提交
    C-->>T: "TinyCode mock model" 响应
    T->>P: write("/exit") + ESC 关菜单 + "\r"
    C-->>T: onExit(code=0)
    T->>T: 校验 ~/.sessions/*.jsonl 含对话内容
```

Sources: [tui.pty.test.ts](tests/tui.pty.test.ts#L102-L111)、[tui.pty.test.ts](tests/tui.pty.test.ts#L119-L125)、[tui.pty.test.ts](tests/tui.pty.test.ts#L204-L211)

## 三条冒烟场景与隔离环境设计

三条测试各自守护一条用户可感知的生命周期路径。所有场景都遵循相同的隔离纪律：`fs.mkdtempSync` 在系统临时目录创建独立的 home 与工作目录，并通过 `TINYCODE_HOME` 环境变量重定向数据目录——这是项目测试体系的通用约定。`makeEnv` 工具函数统一注入 `TINYCODE_MODEL=mock` 与 `TERM=xterm-256color`，并提供可选的密钥剥离开关：用正则 `/API_KEY$|_TOKEN$/` 删除所有疑似凭证的环境变量，同时移除 `TINYCODE_MODEL` 让模型解析故意失败。

| 场景 | 退出方式 | 核心断言 | 单测超时 |
|---|---|---|---|
| 完整对话闭环 | `/exit` 命令 | 退出码 0；会话 `.jsonl` 文件含 `"hello"` 与 `"mock model"` | 90 秒 |
| 无密钥引导面板 | Ctrl+D（`\x04`） | 出现 `"Setup required"` 面板；状态栏显示 `mock/tinycode-mock`；无配置下 Mock 模型仍可应答 | 90 秒 |
| 双击 Ctrl+C | 两次 SIGINT | 出现二次提示后干净退出，退出码 0 | 60 秒 |

第二条场景尤其体现防御性思维：它剥离了宿主环境的全部 API 密钥来模拟"零配置新用户"，验证引导面板正确出现、状态栏回落到 `mock/tinycode-mock`，且 Mock 模型在此状态下依然能够应答——即"未配置也能跑通"是受测试保护的产品契约，而非偶然行为。

Sources: [tui.pty.test.ts](tests/tui.pty.test.ts#L76-L90)、[tui.pty.test.ts](tests/tui.pty.test.ts#L141-L146)、[tui.pty.test.ts](tests/tui.pty.test.ts#L152-L178)

## 平台兼容策略：有条件的跳过而非硬性要求

`node-pty` 是需要本地编译的原生模块。测试注释明确记录了平台决策："凡 node-pty 能编译之处皆可运行：Linux CI 与 macOS。Windows 缺乏对此装置稳定的 ConPTY 支持方案，被有意跳过。"实现上仅用两行完成——`canRunPty = process.platform !== "win32"` 配合 `describe.skipIf(!canRunPty)`，让同一份代码在 Windows 上优雅降级为跳过，而在 Linux/macOS 上全量执行。这比维护两套测试文件或引入复杂的条件加载要简洁得多。

Sources: [tui.pty.test.ts](tests/tui.pty.test.ts#L16-L17)、[tui.pty.test.ts](tests/tui.pty.test.ts#L35)、[tui.pty.test.ts](tests/tui.pty.test.ts#L92)

## Node 多版本 CI 矩阵

CI 工作流（共 48 行）在 push 到 main 和所有 pull request 时触发，核心是一个名为 `test` 的作业，通过矩阵策略在 **Node 22 与 Node 24** 两个大版本上并行执行——与 `package.json` 中声明的 `engines: node >=22.19` 形成呼应：支持的下限版本和当前主线版本都在门禁覆盖之内。矩阵设置了 `fail-fast: false`，确保某个版本的失败不会取消另一版本正在进行的运行，两个版本的结果都能完整呈现。

流水线的六个步骤构成严格递进的门禁序列：

```mermaid
flowchart LR
    A["checkout + setup-node<br/>(npm 缓存)"] --> B["npm install<br/>+ rebuild esbuild/node-pty"]
    B --> C["typecheck<br/>严格 TS 检查"]
    C --> D["lint<br/>eslint"]
    D --> E["build<br/>tsc → dist/"]
    E --> F["npm test<br/>离线 Mock 全量测试<br/>(含 PTY 冒烟)"]
    F --> G["CLI smoke<br/>--version / --help / -p 一次性模式"]
```

值得注意的是最后一步的 CLI 冒烟检查：除了验证 `--version` 和 `--help` 正常输出外，还执行了一次真实的一次性模式调用——`TINYCODE_MODEL=mock TINYCODE_HOME="$PWD/.tmp/ci-home" node dist/cli/index.js -p "hello"` 并 grep 断言输出包含 `"TinyCode mock model"`。这让 CI 在无头路径上也做了一次最小闭环验证，与 PTY 测试的交互式路径互为补充。

Sources: [ci.yml](.github/workflows/ci.yml#L3-L15)、[ci.yml](.github/workflows/ci.yml#L31-L48)、[package.json](package.json#L7-L9)

## 原生依赖与 npm 安装脚本治理

工作流中最具实战经验的一步是安装命令：`npm install && npm rebuild esbuild && npm rebuild node-pty`。其后的注释解释了原因——部分 npm 版本会拦截依赖的安装脚本，而 `esbuild` 需要 postinstall 来绑定 tsx 和 vitest 所依赖的平台二进制，`node-pty` 则必须经过原生编译才能产出可用绑定。项目还在 `package.json` 中维护了 `allowScripts` 白名单，显式放行 `esbuild@0.28.2` 与 `node-pty@1.1.0` 这两个包的脚本执行。这一坑点同样出现在面向用户的快速开始文档中：如果本地安装后报二进制相关错误，执行与 CI 相同的 `npm rebuild esbuild && npm rebuild node-pty` 即可修复。

测试基础设施的接入本身非常轻量：`vitest.config.ts` 只需声明 `include: ["tests/**/*.test.ts"]`，`tui.pty.test.ts` 就自然纳入了默认的 `npm test` 运行——不需要专门的 CI 步骤或标签过滤，PTY 冒烟测试就是常规测试套件的一员，全局的 30 秒 `testTimeout` 与 `hookTimeout` 为各测试自带的更长超时（60–90 秒）留出了覆盖空间。

| 治理手段 | 作用位置 | 解决的问题 |
|---|---|---|
| `npm rebuild esbuild` | CI 安装步骤 | 安装脚本被拦截导致平台二进制缺失 |
| `npm rebuild node-pty` | CI 安装步骤 | 原生模块未经编译无法 spawn PTY |
| `allowScripts` 白名单 | package.json | 显式声明哪些安装脚本是可信且必要的 |
| `describe.skipIf` | 测试文件 | Windows 上 ConPTY 不稳定时的优雅降级 |

Sources: [ci.yml](.github/workflows/ci.yml#L24-L29)、[package.json](package.json#L37-L40)、[vitest.config.ts](vitest.config.ts#L3-L9)

## 小结：门禁背后的工程立场

回顾整套质量门禁，可以看到三条贯穿始终的原则。**离线优先**：从单元测试到 PTY 冒烟再到 CI 冒烟检查，全程只依赖确定性 Mock 模型，README 明确承诺"完全离线——永远不需要 API key"。**真实产物**：PTY 测试驱动的是 `dist/` 构建产物而非源码转译结果，CLI 冒烟直接执行 `node dist/cli/index.js`，杜绝"测试通过但发布物损坏"的裂缝。**故障显式化**：无论是带标签的轮询超时、`Promise.race` 挂起检测器的命名错误信息，还是 `fail-fast: false` 保留的双版本完整结果，设计者始终致力于让失败"说出自己的名字"。对于想为项目贡献代码的开发者，理解这道门禁的意义在于：任何影响 TUI 交互或进程生命周期的改动，都会在这套装置面前接受最接近真实用户体验的检验。

Sources: [README.md](README.md#L180-L192)、[ci.yml](.github/workflows/ci.yml#L43-L48)

---

**延伸阅读**：本页是测试工程章节的收官之作。若尚未阅读前置的 Mock 模型 E2E 策略，建议先看[全离线测试策略：脚本化 Mock 模型驱动真实代理循环的 E2E](26-quan-chi-xian-ce-sai-ce-lve-jiao-ben-hua-mock-mo-xing-qu-dong-zhen-shi-dai-li-xun-huan-de-e2e)（注：目录原文链接为 [全离线测试策略](26-quan-chi-xian-ce-shi-ce-lue-jiao-ben-hua-mock-mo-xing-qu-dong-zhen-shi-dai-li-xun-huan-de-e2e)）；TUI 组件树的进程内测试细节见[流式 TUI 组成：组件树、事件映射与显式重绘规则](24-liu-shi-tui-zu-cheng-zu-jian-shu-shi-jian-ying-she-yu-xian-shi-zhong-hui-gui-ze)；一次性模式的无头语义可参考[一次性模式（-p）：无头运行与权限默认拒绝语义](5-ci-xing-mo-shi-p-wu-tou-yun-xing-yu-quan-xian-mo-ren-ju-jue-yu-yi)。