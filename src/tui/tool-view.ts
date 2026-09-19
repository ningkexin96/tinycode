import type { KnowledgeEditDetails } from "../tools/knowledge.js";
import { fg, bold, dim } from "./theme.js";

/**
 * One-line summaries for tool calls/results, shared by transcript rendering
 * and (potentially) other UIs. Pure functions over tool details.
 */

function argSummary(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  switch (toolName) {
    case "list_tickets":
      return [args.status, args.queue, args.priority, args.category]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join(" ");
    case "get_ticket":
    case "reply_customer":
      return String(args.ticket_id ?? "");
    case "search_tickets":
    case "search_knowledge":
      return String(args.query ?? "");
    case "read_article":
      return String(args.article_id ?? "");
    case "classify_ticket":
      return `${args.ticket_id ?? ""} ${args.category ?? ""} ${args.priority ?? ""}`.trim();
    case "route_ticket":
      return `${args.ticket_id ?? ""} → ${args.queue ?? ""}`.trim();
    case "escalate_ticket":
      return `${args.ticket_id ?? ""} L${args.level ?? "?"}`;
    case "propose_knowledge_edit":
      return `${args.article_id ?? ""} (${
        typeof args.new_text === "string" ? args.new_text.length : 0
      } chars)`;
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
    case "list_tickets":
    case "search_tickets":
      return [`${mark} ${d.count ?? "?"} 条工单`];
    case "search_knowledge":
      return [`${mark} ${d.count ?? "?"} 篇知识`];
    case "get_ticket": {
      const ticket = d.ticket as { id?: string } | undefined;
      return [`${mark} ${ticket?.id ?? "工单已读取"}`];
    }
    case "classify_ticket":
      return [`${mark} ${d.category ?? "?"} · ${d.priority ?? "?"} → triaged`];
    case "route_ticket":
      return [`${mark} → ${d.queue ?? "?"} · routed`];
    case "escalate_ticket":
      return [`${mark} → L${d.level ?? "?"} · escalated`];
    case "reply_customer":
      return [`${mark} 客户回复 ${d.length ?? "?"} 字`];
    case "propose_knowledge_edit": {
      const edit = d as Partial<KnowledgeEditDetails>;
      const skipped = edit.applied === false ? "（短路跳过）" : "";
      const lines = [`${mark} +${edit.additions ?? "?"} -${edit.deletions ?? "?"}${skipped}`];
      if (typeof edit.diff === "string" && edit.diff.length > 0 && !isError) {
        lines.push(...previewDiff(edit.diff));
      }
      return lines;
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
