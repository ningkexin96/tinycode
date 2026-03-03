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
