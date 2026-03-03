import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Conversation compaction: replace the oldest turns with one summary message
 * while protecting the most recent messages verbatim (current task, latest
 * tool calls/errors/edits stay in context).
 */

export interface CompactSplit {
  /** Messages replaced by the summary. Empty when nothing can be compacted. */
  old: AgentMessage[];
  /** Messages kept verbatim. */
  recent: AgentMessage[];
  /** Index into the original array where `recent` starts. */
  cutIndex: number;
}

const MAX_CHARS_PER_MESSAGE = 4000;

/**
 * Choose a cut point on a user-message boundary so no assistant message is
 * separated from its tool results, keeping at least `keepRecent` messages.
 */
export function splitForCompact(messages: AgentMessage[], keepRecent: number): CompactSplit {
  const maxCut = Math.max(0, messages.length - keepRecent);
  let cutIndex = -1;
  for (let index = maxCut; index >= 0; index--) {
    const candidate = messages[index];
    if (candidate && candidate.role === "user") {
      cutIndex = index;
      break;
    }
  }
  if (cutIndex <= 0) {
    return { old: [], recent: messages, cutIndex: messages.length };
  }
  return { old: messages.slice(0, cutIndex), recent: messages.slice(cutIndex), cutIndex };
}

function renderMessage(message: AgentMessage): string {
  const clip = (text: string) =>
    text.length > MAX_CHARS_PER_MESSAGE ? `${text.slice(0, MAX_CHARS_PER_MESSAGE)}\n[…clipped…]` : text;
  if (message.role === "user") {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "image" ? "[image]" : part.text)).join("\n");
    return `[USER]\n${clip(content)}`;
  }
  if (message.role === "assistant") {
    const parts = message.content.map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return "";
      return `[tool call: ${part.name}(${JSON.stringify(part.arguments).slice(0, 300)})]`;
    });
    return `[ASSISTANT]\n${clip(parts.filter((text) => text.length > 0).join("\n"))}`;
  }
  if (message.role === "toolResult") {
    return `[TOOL RESULT for ${message.toolName}${message.isError ? " (error)" : ""}]\n${clip(
      message.content.map((part) => (part.type === "image" ? "[image]" : part.text)).join("\n"),
    )}`;
  }
  return `[${String(message.role).toUpperCase()}] ${clip(JSON.stringify(message))}`;
}

/** Flat transcript rendering used as summarizer input. */
export function buildTranscriptText(messages: readonly AgentMessage[]): string {
  return messages.map(renderMessage).join("\n\n");
}

export function compactSummaryMessage(summaryText: string): AgentMessage {
  return {
    role: "user",
    content:
      `<conversation-summary>\n${summaryText.trim()}\n</conversation-summary>\n\n` +
      `Earlier conversation was summarized above. Continue from the current state.`,
    timestamp: Date.now(),
  };
}

/**
 * Rough token estimate: ~4 chars per token. Provider usage, when available,
 * is more accurate but this works offline and deterministically.
 */
export function estimateTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += JSON.stringify(message).length;
  }
  return Math.ceil(chars / 4);
}
