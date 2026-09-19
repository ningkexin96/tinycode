import { bootstrapHarness, type Harness } from "../bootstrap.js";
import { ModelNotConfiguredError } from "../model/registry.js";
import { loadConfig } from "../config/loader.js";
import { parseModelRef } from "./args.js";

export const VERSION = "1.0.0";

export function printHelp(): void {
  process.stdout.write(
    `
TinyCode v${VERSION} — 客服工单分流业务智能体（基于 Pi）

Usage:
  tinycode [options]            interactive TUI session
  tinycode -p "<prompt>"        one-shot non-interactive run

Options:
  -h, --help                    show this help
  -v, --version                 show version
  -c, --continue                resume the most recent session
  -s, --session <id>            resume a specific session
  -m, --model <provider/model>  override the model for this run
      --permission-mode ask|auto   approval mode (default: ask)
      --mock                    use the scripted offline mock model
      --list-models             list models with configured auth
  -p, --print <prompt>          run one prompt and print the answer

Environment:
  ANTHROPIC_API_KEY / OPENAI_API_KEY / ...   provider credentials
  TINYCODE_MODEL=provider/model              default model
  TINYCODE_PERMISSION_MODE=ask|auto          default permission mode
  TINYCODE_HOME                              data directory override

工作区文件:
  .tinycode/config.json         配置（模型/权限/队列/MCP）
  knowledge/                    知识库 SOP（每篇一份 Markdown）
  tickets/                      工单（每条一个 JSON）
  .tinycode/skills/*/SKILL.md   技能
  TINY.md                       工作区业务规则
`.trimStart(),
  );
}

export function printVersion(): void {
  process.stdout.write(`tinycode ${VERSION}\n`);
}

/** Friendly error rendering shared by all entry points. */
export function reportError(error: unknown): number {
  if (error instanceof ModelNotConfiguredError) {
    process.stderr.write(`\n${error.message}\n\n`);
    return 1;
  }
  process.stderr.write(`\nerror: ${error instanceof Error ? error.message : String(error)}\n\n`);
  return 1;
}

/**
 * Build a harness from CLI flags + config file + environment.
 * Precedence: flags > environment > config file.
 */
export async function buildHarnessFromCli(options: {
  cwd: string;
  modelFlag?: string;
  permissionMode?: "ask" | "auto";
  mock: boolean;
  session?: { mode: "new" } | { mode: "attach"; id: string };
}): Promise<Harness> {
  const { config, warnings } = loadConfig(options.cwd);
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  const modelRef = options.modelFlag ? parseModelRef(options.modelFlag) : undefined;
  const harness = await bootstrapHarness({
    projectRoot: options.cwd,
    config,
    modelRef,
    mock: options.mock,
    session: options.session,
  });
  if (options.permissionMode) {
    applyPermissionMode(harness, options.permissionMode);
  }
  return harness;
}

function applyPermissionMode(harness: Harness, mode: "ask" | "auto"): void {
  harness.permissions.setMode(mode);
}
