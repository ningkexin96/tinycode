import fs from "node:fs";
import { buildHarnessFromCli, printHelp, printVersion, reportError } from "./commands.js";
import { ModelNotConfiguredError } from "../model/registry.js";
import { CliArgsError, parseArgs } from "./args.js";
import { TuiApp } from "../tui/app.js";
import { resolveInteractiveSession, type SessionOption } from "./sessions.js";
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

  // Interactive TUI — always owns a session (new or attached).
  // No provider key configured? Launch anyway in mock mode and onboard
  // inside the UI instead of refusing to start.
  try {
    const session: SessionOption = resolveInteractiveSession(args, cwd);
    let onboardingNotice: string | undefined;
    let harness;
    try {
      harness = await buildHarnessFromCli({
        cwd,
        modelFlag: args.model,
        permissionMode: args.permissionMode,
        mock: args.mock,
        session,
      });
    } catch (error) {
      if (!(error instanceof ModelNotConfiguredError) || args.mock) throw error;
      harness = await buildHarnessFromCli({
        cwd,
        permissionMode: args.permissionMode,
        mock: true,
        session,
      });
      onboardingNotice = error.message;
    }
    const app = new TuiApp(harness.runtime, {
      models: harness.models,
      permissions: harness.permissions,
      session: harness.session,
      skills: harness.skills,
      mcp: harness.mcp,
      subAgents: harness.subAgents,
      projectRoot: cwd,
      onboarding: onboardingNotice,
    });
    // Real terminals with ISIG deliver Ctrl+C as SIGINT; route it through the
    // same interrupt logic as the in-app keybinding.
    const onSigint = () => app.handleInterrupt();
    process.on("SIGINT", onSigint);
    try {
      await app.run();
    } finally {
      process.off("SIGINT", onSigint);
    }
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
    // Headless runs persist only when explicitly resuming; ASK verdicts deny
    // because there is no dialog — auto-approval requires an explicit opt-in.
    const session: SessionOption | undefined = args.continueLast
      ? resolveInteractiveSession(args, cwd)
      : args.sessionId
        ? { mode: "attach", id: args.sessionId }
        : undefined;
    const harness = await buildHarnessFromCli({
      cwd,
      modelFlag: args.model,
      permissionMode: args.permissionMode ?? "ask",
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
