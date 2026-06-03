import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { PermissionManager } from "../permissions/manager.js";
import type { SessionManager } from "../session/manager.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ContextManager, Summarizer } from "../context/manager.js";

/**
 * TinyCodeRuntime glues the Pi Agent loop to TinyCode's harness policies:
 *
 * - permission gate on every tool call (beforeToolCall)
 * - tool-result truncation (afterToolCall)
 * - auto-compaction of oversized context (transformContext)
 * - session persistence of finalized messages (subscribe)
 */
export interface RuntimeOptions {
  projectRoot: string;
  systemPrompt: string;
  model: Model<any>;
  streamFn: StreamFn;
  tools: ToolRegistry;
  permissions: PermissionManager;
  contextManager: ContextManager;
  summarize: Summarizer;
  session?: SessionManager;
}

export class TinyCodeRuntime {
  readonly agent: Agent;

  constructor(public readonly options: RuntimeOptions) {
    this.agent = new Agent({
      streamFn: options.streamFn,
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        // "minimal" rather than "off": several hosted endpoints (e.g.
        // OpenRouter claude-haiku-4.5) reject requests that disable reasoning
        // outright, while models without thinking support ignore the hint.
        thinkingLevel: "minimal",
        tools: options.tools.list(),
      },
      transformContext: options.contextManager.makeTransformContext(options.summarize),
      beforeToolCall: async ({ toolCall, args }) => {
        const decision = await options.permissions.check(
          toolCall.name,
          (args ?? {}) as Record<string, unknown>,
        );
        if (decision.action === "deny") {
          return { block: true, reason: `Permission denied: ${decision.reason}` };
        }
        return undefined;
      },
      afterToolCall: async (context) => options.contextManager.handleAfterToolCall(context),
    });

    if (options.session) {
      const session = options.session;
      this.agent.subscribe(async (event: AgentEvent) => {
        if (event.type === "message_end") {
          session.record(event.message);
        }
      });
    }
  }

  /** Send one user message and run the loop to completion. */
  prompt(text: string): Promise<void> {
    return this.agent.prompt(text);
  }

  abort(): void {
    this.agent.abort();
  }

  /** Hot-swap the model (used by /model and --model). */
  setModel(model: Model<any>): void {
    this.agent.state.model = model;
  }

  get busy(): boolean {
    return this.agent.state.isStreaming;
  }

  /**
   * Manual compaction (/compact): summarize older turns and replace the live
   * transcript with [summary, ...recent]. Returns a status line.
   */
  async compactNow(): Promise<string> {
    const messages = [...this.agent.state.messages];
    if (messages.length === 0) return "Nothing to compact yet.";
    const before = this.options.contextManager.estimate(messages);
    const compacted = await this.options.contextManager.compact(messages, this.options.summarize);
    if (compacted.length === messages.length) return "Nothing compactable (recent conversation is protected).";
    this.agent.state.messages.splice(0, this.agent.state.messages.length, ...compacted);
    return `Compacted: ${messages.length} → ${compacted.length} messages (~${before} → ~${this.options.contextManager.estimate(compacted)} tokens est.)`;
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }
}
