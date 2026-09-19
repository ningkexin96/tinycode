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
 *
 * On top of that, {@link TinyCodeRuntime.runAgentTurn} is the multi-turn
 * execution closure used by both the TUI and headless mode. It wraps one user
 * message into a bounded run with fallbacks for the three failure modes that
 * long ticket sessions hit: empty responses, thinking-only output, and runaway
 * tool loops.
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
  /** Steps (assistant turns) allowed per runAgentTurn call before the guard stops it. */
  maxStepsPerTurn?: number;
}

export type AgentTurnStatus = "completed" | "empty-response" | "max-steps";

export interface AgentTurnResult {
  status: AgentTurnStatus;
  /** Assistant turns executed in this run. */
  steps: number;
  /** Tool calls executed in this run. */
  toolCalls: number;
  /** Final assistant text (empty when the model produced none). */
  text: string;
  /** Human-readable fallback explanation when status !== "completed". */
  note?: string;
}

/** Per-run guard state (reset at the start of every runAgentTurn). */
interface TurnGuard {
  active: boolean;
  steps: number;
  toolCalls: number;
  maxSteps: number;
  limitHit: boolean;
}

export class TinyCodeRuntime {
  readonly agent: Agent;
  private readonly guard: TurnGuard = {
    active: false,
    steps: 0,
    toolCalls: 0,
    maxSteps: 0,
    limitHit: false,
  };

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
      // Max-step guard: only enforces while a runAgentTurn is active.
      shouldStopAfterTurn: () => {
        if (!this.guard.active) return false;
        this.guard.steps += 1;
        if (this.guard.maxSteps > 0 && this.guard.steps >= this.guard.maxSteps) {
          this.guard.limitHit = true;
          return true;
        }
        return false;
      },
    });

    this.agent.subscribe(async (event: AgentEvent) => {
      if (this.guard.active && event.type === "tool_execution_start") {
        this.guard.toolCalls += 1;
      }
      if (options.session && event.type === "message_end") {
        options.session.record(event.message);
      }
    });
  }

  /** Send one user message and run the loop to completion. */
  prompt(text: string): Promise<void> {
    return this.agent.prompt(text);
  }

  /**
   * Multi-turn execution closure for one user/ticket message.
   *
   * Guarantees a structured outcome even when the model misbehaves:
   * - `max-steps`      — the turn guard stopped a runaway tool loop;
   * - `empty-response` — the model returned no text (often thinking-only);
   * - `completed`      — a normal assistant answer.
   *
   * The transcript is always left in a consistent state so the next turn (or a
   * resumed session) can continue from it.
   */
  async runAgentTurn(
    text: string,
    options: { maxSteps?: number } = {},
  ): Promise<AgentTurnResult> {
    const guard = this.guard;
    guard.active = true;
    guard.steps = 0;
    guard.toolCalls = 0;
    guard.limitHit = false;
    guard.maxSteps = options.maxSteps ?? this.options.maxStepsPerTurn ?? 12;

    try {
      await this.agent.prompt(text);
    } finally {
      guard.active = false;
    }

    const finalText = lastAssistantText(this.agent.state.messages);

    if (guard.limitHit) {
      return {
        status: "max-steps",
        steps: guard.steps,
        toolCalls: guard.toolCalls,
        text: finalText,
        note: `已达到单轮最大步数 ${guard.maxSteps}，已中止本轮以避免工具调用失控。`,
      };
    }

    if (finalText.trim().length === 0) {
      return {
        status: "empty-response",
        steps: guard.steps,
        toolCalls: guard.toolCalls,
        text: "",
        note: "模型本轮未返回任何正文（可能只输出了思考或直接结束），已按空响应兜底。",
      };
    }

    return {
      status: "completed",
      steps: guard.steps,
      toolCalls: guard.toolCalls,
      text: finalText,
    };
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

/** Extract the text of the last assistant message (empty when there is none). */
function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown } | undefined;
    if (message && message.role === "assistant") {
      return collectText(message.content);
    }
  }
  return "";
}

/** Join the `text` parts of an assistant message's content array. */
function collectText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const value = (part as { text?: unknown }).text;
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n").trim();
}
