import os from "node:os";
import path from "node:path";
import { classifyCommand } from "./classifier.js";

/**
 * Static decision rules evaluated BEFORE any user interaction.
 */

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRuleInput {
  toolName: string;
  input: Record<string, unknown>;
  projectRoot: string;
}

export interface RuleVerdict {
  action: PermissionAction;
  reason: string;
}

/**
 * Resolve a tool input path against the project root.
 * Returns an absolute path plus whether it stays inside the project.
 */
export function resolveToolPath(
  projectRoot: string,
  raw: string | undefined,
): { absolute: string; insideProject: boolean } {
  if (!raw || raw.length === 0) {
    return { absolute: projectRoot, insideProject: true };
  }
  const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  const absolute = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(projectRoot, expanded);
  const relative = path.relative(projectRoot, absolute);
  const insideProject = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return { absolute, insideProject };
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Hard DENY for catastrophic shell commands. These are refused outright —
 * auto mode, remembered patterns, and user approval never override them.
 * Deliberately tiny: only commands whose damage is unrecoverable.
 */
const HARD_DENY_BASH: Array<{ label: string; test: RegExp }> = [
  { label: "recursive force-delete of filesystem root", test: /\brm\s+[^\n]*\s\/\*?\s*(?:&&|$|;)/ },
  { label: "delete home directory", test: /\brm\s+[^\n]*\s(~|\$HOME)(?:\s|$)/ },
  { label: "format filesystem", test: /\bmkfs(\.\w+)?\b/ },
  { label: "raw disk write", test: /\bdd\b[^\n]*\bof=\/dev\/(disk|sd|nvme|mmcblk)/ },
  { label: "world-writable root", test: /\bchmod\s+-R\s+777\s+\// },
];

export function findHardDeny(command: string): string | undefined {
  for (const rule of HARD_DENY_BASH) {
    if (rule.test.test(command)) return rule.label;
  }
  return undefined;
}

export function evaluateRules({
  toolName,
  input,
  projectRoot,
}: PermissionRuleInput): RuleVerdict {
  if (READ_ONLY_TOOLS.has(toolName)) {
    const target = typeof input.path === "string" ? input.path : ".";
    const { insideProject } = resolveToolPath(projectRoot, target);
    if (insideProject) return { action: "allow", reason: "read-only inside project" };
    return { action: "ask", reason: `access outside project: ${target}` };
  }

  if (toolName === "write" || toolName === "edit") {
    const { insideProject } = resolveToolPath(projectRoot, String(input.path ?? ""));
    if (!insideProject) {
      return { action: "ask", reason: `write outside project: ${input.path}` };
    }
    return { action: "ask", reason: `${toolName} modifies project files` };
  }

  if (toolName === "bash") {
    const command = String(input.command ?? "");
    const denied = findHardDeny(command);
    if (denied) {
      return { action: "deny", reason: `catastrophic command refused: ${denied}` };
    }
    const { insideProject } = resolveToolPath(
      projectRoot,
      typeof input.cwd === "string" ? input.cwd : undefined,
    );
    if (!insideProject) {
      return { action: "ask", reason: `working directory outside project: ${String(input.cwd)}` };
    }
    const classification = classifyCommand(command);
    switch (classification.risk) {
      case "safe":
        return { action: "allow", reason: classification.reasons[0] ?? "known read-only command" };
      case "write":
        return { action: "ask", reason: classification.reasons.join(", ") || "mutating command" };
      case "destructive":
        return { action: "ask", reason: `dangerous: ${classification.reasons.join(", ")}` };
    }
  }

  // Tools registered later (MCP, sub-agents, skills) default to asking.
  return { action: "ask", reason: `unclassified tool "${toolName}"` };
}
