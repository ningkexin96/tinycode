import type { BashDetails } from "../tools/bash.js";
import type { EditDetails } from "../tools/edit.js";
import type { WriteDetails } from "../tools/write.js";
import { fg, bold, dim } from "./theme.js";

/**
 * One-line summaries for tool calls/results, shared by transcript rendering
 * and (potentially) other UIs. Pure functions over tool details.
 */

function argSummary(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
      return String(args.path ?? "");
    case "bash":
      return String(args.command ?? "");
    case "grep":
      return `/${args.pattern ?? ""}/${args.include ? ` in ${String(args.include)}` : ""}`;
    case "find":
      return String(args.pattern ?? "");
    case "ls":
      return String(args.path ?? ".");
    case "load_skill":
      return String(args.name ?? "");
    default:
      return Object.values(args)
        .map((value) => (typeof value === "string" ? value : ""))
        .filter((text) => text.length > 0)
        .join(" ")
        .slice(0, 60);
  }
}

export function formatToolStart(toolName: string, args?: Record<string, unknown>): string {
  return `${bold(fg.brightMagenta("●"))} ${fg.brightMagenta(toolName)} ${dim(argSummary(toolName, args))}`;
}

/** Result lines under a tool entry; `details` comes from the tool itself. */
export function formatToolResultLines(
  toolName: string,
  details: unknown,
  isError: boolean,
): string[] {
  const d = (details ?? {}) as Record<string, unknown>;
  const mark = isError ? fg.brightRed("✗") : fg.brightGreen("✓");

  switch (toolName) {
    case "read": {
      const lines = typeof d.totalLines === "number" ? d.totalLines : (d.lineCount as number) ?? "?";
      return [`${mark} ${lines} lines`];
    }
    case "bash": {
      const b = d as Partial<BashDetails>;
      const seconds = typeof b.durationMs === "number" ? `${(b.durationMs / 1000).toFixed(1)}s` : "?";
      const status = b.timedOut
        ? "timeout"
        : b.exitCode === 0 || b.exitCode == null
          ? `exit ${b.exitCode ?? "?"}`
          : `exit ${b.exitCode}`;
      return [`${mark} ${status} · ${seconds}`];
    }
    case "edit": {
      const e = d as Partial<EditDetails>;
      return [
        `${mark} +${e.additions ?? "?"} -${e.deletions ?? "?"}`,
        ...(typeof e.diff === "string" && e.diff.length > 0 && !isError ? previewDiff(e.diff) : []),
      ];
    }
    case "write": {
      const w = d as Partial<WriteDetails>;
      return [`${mark} ${w.created ? "created" : "overwritten"} · +${w.additions ?? "?"} -${w.deletions ?? "?"}`];
    }
    case "grep": {
      return [`${mark} ${d.matches ?? "?"} match(es) in ${d.filesSearched ?? "?"} files`];
    }
    case "find": {
      return [`${mark} ${d.count ?? "?"} file(s)`];
    }
    case "ls": {
      return [`${mark} ${d.count ?? "?"} entr(y|ies)`];
    }
    default:
      return [`${mark} done`];
  }
}

function previewDiff(diffText: string, maxLines = 10): string[] {
  return diffText
    .split("\n")
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    .slice(0, maxLines)
    .map((line) => (line.startsWith("+") ? fg.brightGreen(line) : fg.brightRed(line)));
}
