import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Summarizer } from "../context/manager.js";
import { ContextManager } from "../context/manager.js";
import { PermissionManager } from "../permissions/manager.js";
import { TinyCodeRuntime } from "../agent/runtime.js";
import { ToolRegistry } from "../tools/registry.js";

const WORKER_SYSTEM_PROMPT = `You are a TinyCode research worker: an isolated READ-ONLY sub-agent.

Your job is to investigate one focused task using your tools (read, grep, find, ls)
and then produce a concise structured report:
- What you found (facts, file paths, line references)
- Assessment relevant to the parent's question
- Nothing else

You cannot modify files or run commands. Be precise and complete in a single reply.`;

export interface WorkerOptions {
  projectRoot: string;
  model: Model<any>;
  streamFn: StreamFn;
  /** Read-only tools plus any MCP tools deemed safe by the host. */
  tools: AgentTool[];
}

/**
 * A worker is an independent Pi Agent instance with its own context,
 * AbortController (via Agent.abort) and transcript. It shares nothing
 * mutable with the root conversation.
 */
export class WorkerAgent {
  readonly registry = new ToolRegistry();
  readonly permissions: PermissionManager;
  readonly contextManager: ContextManager;
  readonly runtime: TinyCodeRuntime;

  constructor(options: WorkerOptions) {
    for (const tool of options.tools) this.registry.register(tool);
    // Workers auto-approve their read-only tools; no dialog exists inside them.
    this.permissions = new PermissionManager({ mode: "auto", projectRoot: options.projectRoot });
    // Workers keep truncation but never auto-compact: their transcripts are
    // short-lived and a lossy summary would corrupt an in-flight investigation.
    this.contextManager = new ContextManager({
      maxToolResultChars: 20_000,
      compactAboveTokens: 0,
      keepRecentMessages: 12,
    });
    const identitySummarize: Summarizer = async (transcript) => transcript.slice(0, 2000);
    this.runtime = new TinyCodeRuntime({
      projectRoot: options.projectRoot,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      model: options.model,
      streamFn: options.streamFn,
      tools: this.registry,
      permissions: this.permissions,
      contextManager: this.contextManager,
      summarize: identitySummarize,
    });
  }

  get agent() {
    return this.runtime.agent;
  }
}
