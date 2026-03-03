import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  buildTranscriptText,
  compactSummaryMessage,
  estimateTokens,
  splitForCompact,
} from "./compact.js";
import { saveArtifact, truncateMiddle } from "./tool-results.js";

/**
 * ContextManager owns the two context-policy hooks the runtime installs:
 *
 * - afterToolCall: cap every tool result in the transcript (full output is
 *   preserved as an artifact file).
 * - transformContext: when the estimated context exceeds the budget, older
 *   turns are replaced by an LLM-generated summary before the next request.
 */

export interface Summarizer {
  (transcript: string, signal?: AbortSignal): Promise<string>;
}

export interface ContextManagerOptions {
  maxToolResultChars: number;
  /** Auto-compact above this many estimated tokens; 0 disables auto mode. */
  compactAboveTokens: number;
  keepRecentMessages: number;
  artifactsDir?: string;
}

export class ContextManager {
  constructor(private readonly options: ContextManagerOptions) {}

  /** Agent.afterToolCall hook: enforce the per-result size budget. */
  handleAfterToolCall(context: AfterToolCallContext): AfterToolCallResult | undefined {
    const result = context.result;
    let droppedTotal = 0;
    const content = result.content.map((part) => {
      if (part.type !== "text") return part;
      const truncated = truncateMiddle(part.text, this.options.maxToolResultChars);
      if (truncated.droppedChars === 0) return part;
      droppedTotal += truncated.droppedChars;

      if (this.options.artifactsDir) {
        try {
          const full = (part as TextContent).text;
          const artifact = saveArtifact(this.options.artifactsDir, context.toolCall.name, full);
          return {
            type: "text" as const,
            text: `${truncated.text}\n[full output saved to ${artifact}]`,
          };
        } catch {
          // Artifact persistence is best-effort; truncation still applies.
        }
      }
      return { type: "text" as const, text: truncated.text };
    });

    if (droppedTotal === 0) return undefined;
    return {
      content,
      details: result.details,
      isError: context.isError,
    };
  }

  estimate(messages: readonly AgentMessage[]): number {
    return estimateTokens(messages);
  }

  shouldAutoCompact(messages: readonly AgentMessage[]): boolean {
    if (this.options.compactAboveTokens <= 0) return false;
    return this.estimate(messages) > this.options.compactAboveTokens;
  }

  /**
   * Compact a transcript into [summary message, ...recent].
   * Returns the input unchanged when there is nothing safely compactable.
   */
  async compact(
    messages: readonly AgentMessage[],
    summarize: Summarizer,
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const split = splitForCompact([...messages], this.options.keepRecentMessages);
    if (split.old.length === 0) return [...messages];
    const summaryText = await summarize(buildTranscriptText(split.old), signal);
    return [compactSummaryMessage(summaryText), ...split.recent];
  }

  makeTransformContext(summarize: Summarizer) {
    return async (
      messages: AgentMessage[],
      signal?: AbortSignal,
    ): Promise<AgentMessage[]> => {
      if (!this.shouldAutoCompact(messages)) return messages;
      return this.compact(messages, summarize, signal);
    };
  }
}
