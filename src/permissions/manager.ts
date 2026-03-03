import { evaluateRules } from "./rules.js";

/**
 * The permission layer every tool execution passes through.
 *
 * Flow: static rules → remembered "always allow" patterns → mode.
 * In "auto" mode everything except hard DENY rules is approved without
 * prompting (used by tests/CI via TINYCODE_PERMISSION_MODE=auto).
 * In "ask" mode the host supplies a prompt callback (TUI dialog or CLI
 * fallback); a missing callback denies safely instead of crashing.
 */

export interface PermissionRequestView {
  toolName: string;
  /** One-line human summary, e.g. the shell command or target path. */
  title: string;
  /** Multi-line detail shown in the dialog body. */
  detail?: string;
  reason: string;
}

/** The user's answer from a dialog. */
export type PromptOutcome = "once" | "always" | "deny";

export type PromptFn = (request: PermissionRequestView) => Promise<PromptOutcome>;

export type Decision =
  | { action: "allow"; reason: string }
  | { action: "deny"; reason: string };

interface ManagerOptions {
  mode: "ask" | "auto";
  projectRoot: string;
  prompt?: PromptFn;
}

/** Session-scoped "always allow this pattern" memory. */
interface AllowPattern {
  toolName: string;
  /** Prefix match against the rendered request title (lowercase). */
  titlePrefix: string;
}

export class PermissionManager {
  private readonly patterns: AllowPattern[] = [];

  constructor(private options: ManagerOptions) {}

  get mode(): "ask" | "auto" {
    return this.options.mode;
  }

  setMode(mode: "ask" | "auto"): void {
    this.options.mode = mode;
  }

  setPrompt(prompt: PromptFn): void {
    this.options.prompt = prompt;
  }

  /** Remember an approval pattern, e.g. bash commands starting with "npm install". */
  rememberAlways(toolName: string, titlePrefix: string): void {
    this.patterns.push({
      toolName,
      titlePrefix: titlePrefix.trim().toLowerCase(),
    });
  }

  listPatterns(): readonly AllowPattern[] {
    return this.patterns;
  }

  private matchesRemembered(toolName: string, title: string): boolean {
    const normalized = title.trim().toLowerCase();
    return this.patterns.some(
      (pattern) =>
        pattern.toolName === toolName &&
        (normalized === pattern.titlePrefix || normalized.startsWith(`${pattern.titlePrefix} `)),
    );
  }

  async check(toolName: string, input: Record<string, unknown>): Promise<Decision> {
    const verdict = evaluateRules({ toolName, input, projectRoot: this.options.projectRoot });

    if (verdict.action === "deny") {
      return { action: "deny", reason: verdict.reason };
    }

    const title = renderTitle(toolName, input);

    if (verdict.action === "allow") {
      return { action: "allow", reason: verdict.reason };
    }

    // ASK verdicts:
    if (this.matchesRemembered(toolName, title)) {
      return { action: "allow", reason: "allowed by remembered pattern" };
    }
    if (this.options.mode === "auto") {
      return { action: "allow", reason: `auto-approved (${verdict.reason})` };
    }

    const prompt = this.options.prompt;
    if (!prompt) {
      return { action: "deny", reason: `no permission prompt available: ${verdict.reason}` };
    }
    let outcome: PromptOutcome;
    try {
      outcome = await prompt({ toolName, title, detail: renderDetail(input), reason: verdict.reason });
    } catch (error) {
      return { action: "deny", reason: `permission prompt failed: ${(error as Error).message}` };
    }
    if (outcome === "always") {
      // Remember the command family ("npm install"), not one exact invocation,
      // so similar future requests skip the dialog.
      this.rememberAlways(toolName, derivePatternPrefix(toolName, title));
      return { action: "allow", reason: "allowed always (remembered)" };
    }
    if (outcome === "once") {
      return { action: "allow", reason: "allowed once" };
    }
    return { action: "deny", reason: "denied by user" };
  }
}

function renderTitle(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
      return String(input.command ?? "");
    case "read":
    case "write":
    case "edit":
    case "grep":
    case "find":
    case "ls":
      return `${toolName} ${String(input.path ?? "")}`.trim();
    default:
      return `${toolName} ${JSON.stringify(input)}`;
  }
}

/** Reduce a request to its approval family: first two words for bash, else the tool name + head token. */
function derivePatternPrefix(toolName: string, title: string): string {
  const words = title.trim().split(/\s+/);
  if (toolName === "bash") return words.slice(0, 2).join(" ");
  return `${toolName} ${words[1] ?? ""}`.trim();
}

function renderDetail(input: Record<string, unknown>): string | undefined {
  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    return `replace:\n${clip(input.oldText)}\nwith:\n${clip(input.newText)}`;
  }
  if (typeof input.content === "string") {
    return clip(input.content);
  }
  return undefined;
}

function clip(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}
