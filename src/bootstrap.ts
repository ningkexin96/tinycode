import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { TinyCodeRuntime } from "./agent/runtime.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import type { Summarizer } from "./context/manager.js";
import { ContextManager } from "./context/manager.js";
import { SubAgentManager } from "./agents/manager.js";
import { createSubAgentTools } from "./agents/tools.js";
import { SessionManager } from "./session/manager.js";
import { PermissionManager } from "./permissions/manager.js";
import { SkillRegistry, createLoadSkillTool } from "./skills/registry.js";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "./tools/index.js";
import { ToolRegistry } from "./tools/registry.js";
import type { McpServerConfig, TinyCodeConfig } from "./config/schema.js";
import { McpManager } from "./mcp/manager.js";
import { registerMcpTools } from "./mcp/adapter.js";
import { ModelRegistry, type ModelRef } from "./model/registry.js";
import { sessionsDir } from "./config/loader.js";

const COMPACTION_SYSTEM_PROMPT =
  "You summarize coding-agent conversations. Produce a dense handoff note: the user's goal, " +
  "what was tried, files modified (with paths), current state, test/build results, and exact next steps. " +
  "Keep code identifiers verbatim. No prose padding.";

/**
 * bootstrapHarness assembles the whole product around the Pi Agent loop:
 * tools, permissions, context policy, session persistence, skills, MCP and
 * sub-agents. Both the TUI and the non-interactive mode build on this.
 */
export interface BootstrapOptions {
  projectRoot: string;
  config: TinyCodeConfig;
  /** CLI/config resolved model reference. */
  modelRef?: ModelRef;
  mock?: boolean;
  session?: { mode: "new" } | { mode: "attach"; id: string };
}

export interface Harness {
  projectRoot: string;
  config: TinyCodeConfig;
  models: ModelRegistry;
  model: Model<any>;
  permissions: PermissionManager;
  contextManager: ContextManager;
  runtime: TinyCodeRuntime;
  tools: ToolRegistry;
  session?: SessionManager;
  skills: SkillRegistry;
  mcp?: McpManager;
  subAgents?: SubAgentManager;
  shutdown(): Promise<void>;
}

export async function bootstrapHarness(options: BootstrapOptions): Promise<Harness> {
  const { projectRoot, config } = options;

  const models = new ModelRegistry();
  // Sensible default: full 32k+ model limits trip prepaid-credit preflight
  // checks (OpenRouter 402). Override via config.maxOutputTokens.
  models.setMaxOutputTokens(config.maxOutputTokens ?? 16384);
  const wantMock = options.mock === true || process.env.TINYCODE_MODEL === "mock";
  if (wantMock || (!options.modelRef && !config.provider && !config.model && process.env.TINYCODE_MODEL === "mock")) {
    models.enableMock();
  }
  const modelRef: ModelRef = {
    provider: options.modelRef?.provider ?? config.provider,
    model: options.modelRef?.model ?? config.model,
  };
  const model = await models.resolve(modelRef);

  // Permissions
  const permissions = new PermissionManager({
    mode: config.permissionMode ?? "ask",
    projectRoot,
  });

  // Context policy
  const contextLimit = typeof model.contextWindow === "number" ? model.contextWindow : undefined;
  const contextManager = new ContextManager({
    maxToolResultChars: config.context?.maxToolResultChars ?? 30_000,
    compactAboveTokens:
      config.context?.compactAboveTokens ??
      (contextLimit ? Math.floor(contextLimit * 0.8) : 100_000),
    keepRecentMessages: config.context?.keepRecentMessages ?? 12,
    artifactsDir: path.join(sessionsDir(), "artifacts"),
  });

  // Skills (progressive disclosure: only summaries enter the prompt)
  const skills = new SkillRegistry();
  skills.discover(projectRoot);

  // Sessions
  let session: SessionManager | undefined;
  if (options.session) {
    session = new SessionManager(sessionsDir());
    if (options.session.mode === "new") {
      session.start(projectRoot, `${model.provider}/${model.id}`);
    } else {
      session.attach(options.session.id, projectRoot, `${model.provider}/${model.id}`);
    }
  }

  // Tools
  const tools = new ToolRegistry();
  for (const factory of [
    createReadTool,
    createWriteTool,
    createEditTool,
    createBashTool,
    createGrepTool,
    createFindTool,
    createLsTool,
  ] as ((root: string) => AgentTool)[]) {
    tools.register(factory(projectRoot));
  }
  tools.register(createLoadSkillTool(skills));

  // Sub-agents (workers are read-only)
  const workerTools: AgentTool[] = [
    createReadTool(projectRoot),
    createGrepTool(projectRoot),
    createFindTool(projectRoot),
    createLsTool(projectRoot),
  ];
  const subAgents = new SubAgentManager({
    projectRoot,
    model,
    streamFn: models.streamFn,
    workerTools,
    maxConcurrent: 3,
  });
  for (const tool of createSubAgentTools(subAgents)) tools.register(tool);

  // MCP servers (failures recorded, never fatal)
  let mcp: McpManager | undefined;
  const mcpServers = (config.mcpServers ?? {}) as Record<string, McpServerConfig>;
  if (Object.keys(mcpServers).length > 0) {
    mcp = new McpManager(mcpServers);
    await mcp.startAll();
    registerMcpTools(tools, mcp);
  }

  // System prompt with project memory (TINY.md, compatible fallbacks)
  const memory = readProjectMemory(projectRoot);
  const systemPrompt = buildSystemPrompt({
    projectRoot,
    platform: `${os.platform()} ${os.arch()} · node ${process.version}`,
    memory,
    skills: skills.summary(),
  });

  const summarize = makeDefaultSummarizer(models, model);

  const runtime = new TinyCodeRuntime({
    projectRoot,
    systemPrompt,
    model,
    streamFn: models.streamFn,
    tools,
    permissions,
    contextManager,
    summarize,
    session,
  });

  // Resume an attached session into the live transcript.
  if (session && options.session?.mode === "attach") {
    const loaded = session.load(options.session.id);
    if (loaded) {
      runtime.agent.state.messages.splice(0, runtime.agent.state.messages.length, ...loaded.messages);
    }
  }

  return {
    projectRoot,
    config,
    models,
    model,
    permissions,
    contextManager,
    runtime,
    tools,
    session,
    skills,
    mcp,
    subAgents,
    async shutdown() {
      await mcp?.shutdown();
      await subAgents.shutdown();
    },
  };
}

/** Project memory: TINY.md is the standard; AGENTS.md/CLAUDE.md are compatible extras. */
function readProjectMemory(projectRoot: string): string | undefined {
  const parts: string[] = [];
  for (const name of ["TINY.md", "AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = fs.readFileSync(path.join(projectRoot, name), "utf8").trim();
      if (text.length > 0) parts.push(`### ${name}\n\n${text}`);
    } catch {
      // file absent: skip
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Default compaction summarizer: one plain LLM call via pi-ai Models. */
function makeDefaultSummarizer(models: ModelRegistry, model: Model<any>): Summarizer {
  return async (transcript, signal) => {
    try {
      const message = await models.models.completeSimple(
        model,
        {
          systemPrompt: COMPACTION_SYSTEM_PROMPT,
          messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
        },
        { signal },
      );
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      return text.length > 0 ? text : "(empty summary)";
    } catch (error) {
      return `(summary failed: ${(error as Error).message})`;
    }
  };
}
