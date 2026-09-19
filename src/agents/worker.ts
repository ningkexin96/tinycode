import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Summarizer } from "../context/manager.js";
import { ContextManager } from "../context/manager.js";
import { PermissionManager } from "../permissions/manager.js";
import { TinyCodeRuntime } from "../agent/runtime.js";
import { ToolRegistry } from "../tools/registry.js";

const WORKER_SYSTEM_PROMPT = `你是 TinyCode 的只读调研子智能体（research worker），运行在隔离的上下文里。

你的任务是围绕一个聚焦的子问题取证：使用你可用的工具
（list_tickets / get_ticket / search_tickets / search_knowledge / read_article），
然后输出一份简洁的结构化报告：
- 事实：命中的工单号 / 知识库文章 id，以及关键原文摘录
- 与本问题的相关性判断
- 其余内容一律不要输出

你不能修改工单或知识库，也不能执行分类/分流/回复等处理动作。
请在单次回复中给出精确、完整的结论。`;

export interface WorkerOptions {
  projectRoot: string;
  model: Model<any>;
  streamFn: StreamFn;
  /** Read-only domain tools plus any MCP tools deemed safe by the host. */
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
