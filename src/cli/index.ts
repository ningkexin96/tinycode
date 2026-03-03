import fs from "node:fs";
import { buildHarnessFromCli, printHelp, printVersion, reportError } from "./commands.js";
import { CliArgsError, parseArgs } from "./args.js";
import { TuiApp } from "../tui/app.js";
import { sessionsDir } from "../config/loader.js";
import { SessionManager } from "../session/manager.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliArgsError) {
      process.stderr.write(`tinycode: ${error.message}\nRun \`tinycode --help\` for usage.\n`);
      return 2;
    }
    throw error;
  }

  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.version) {
    printVersion();
    return 0;
  }

  const cwd = process.cwd();
  if (!fs.existsSync(cwd)) {
    process.stderr.write(`tinycode: working directory does not exist: ${cwd}\n`);
    return 2;
  }

  if (args.listModels) {
    return listModels(cwd);
  }

  // One-shot non-interactive mode.
  if (args.prompt !== undefined) {
    return runPrintMode(cwd, args.prompt, args);
  }

  // Interactive TUI.
  try {
    const session = args.continueLast
      ? await resolveLatestSession(cwd)
      : args.sessionId
        ? ({ mode: "attach", id: args.sessionId } as const)
        : undefined;
    const harness = await buildHarnessFromCli({
      cwd,
      modelFlag: args.model,
      permissionMode: args.permissionMode,
      mock: args.mock,
      session,
    });
    const app = new TuiApp(harness.runtime, {
      models: harness.models,
      permissions: harness.permissions,
      session: harness.session,
      skills: harness.skills,
      mcp: harness.mcp,
      subAgents: harness.subAgents,
      projectRoot: cwd,
    });
    await app.run();
    await harness.shutdown();
    return 0;
  } catch (error) {
    return reportError(error);
  }
}

/** -p mode: run one prompt headlessly and print the final answer. */
async function runPrintMode(
  cwd: string,
  prompt: string,
  args: ReturnType<typeof parseArgs>,
): Promise<number> {
  try {
    const session = args.continueLast
      ? await resolveLatestSession(cwd)
      : args.sessionId
        ? ({ mode: "attach", id: args.sessionId } as const)
        : undefined;
    const harness = await buildHarnessFromCli({
      cwd,
      modelFlag: args.model,
      permissionMode: args.permissionMode ?? "auto",
      mock: args.mock,
      session,
    });

    let finalText = "";
    harness.runtime.agent.subscribe(async (event) => {
      if (event.type === "agent_end") {
        finalText = extractFinalText(event.messages);
      }
    });

    await harness.runtime.prompt(prompt);
    await harness.shutdown();

    process.stdout.write(finalText.length > 0 ? `${finalText}\n` : "(no response)\n");
    return 0;
  } catch (error) {
    return reportError(error);
  }
}

function extractFinalText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

/** Resolve the most recent session for --continue. */
async function resolveLatestSession(
  cwd: string,
): Promise<{ mode: "attach"; id: string } | undefined> {
  const manager = new SessionManager(sessionsDir());
  const latest = manager.list().find((session) => session.cwd === cwd);
  if (!latest) {
    process.stderr.write("tinycode: no previous session to continue.\n");
    process.exit(2);
  }
  return { mode: "attach", id: latest.id };
}

/** --list-models: show models whose providers have credentials configured. */
async function listModels(cwd: string): Promise<number> {
  try {
    const harness = await buildHarnessFromCli({ cwd, mock: false });
    const available = await harness.models.availableWithAuth();
    await harness.shutdown();
    if (available.length === 0) {
      process.stdout.write(
        "No models with configured auth found.\nSet ANTHROPIC_API_KEY / OPENAI_API_KEY / ... or use TINYCODE_MODEL=mock.\n",
      );
      return 1;
    }
    for (const model of available.slice(0, 50)) {
      process.stdout.write(`${model.provider}/${model.id} — ${model.name ?? ""}\n`);
    }
    return 0;
  } catch (error) {
    return reportError(error);
  }
}

process.exitCode = await main();
