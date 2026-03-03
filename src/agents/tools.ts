import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { statusLabel, type SubAgentManager } from "./manager.js";

/**
 * Root-agent tools for supervising read-only workers.
 * Workers themselves never receive these tools, so recursion is impossible.
 */
export function createSubAgentTools(manager: SubAgentManager): AgentTool[] {
  const spawnSchema = Type.Object({
    name: Type.String({ description: "Short unique worker name, e.g. \"frontend-inspector\"" }),
    task: Type.String({ description: "Precise investigation task for the worker" }),
  });
  const spawn: AgentTool<typeof spawnSchema> = {
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Spawn a read-only research worker with its own context to investigate a focused task " +
      "(e.g. inspect one area of the codebase). It can read/search but cannot modify files. " +
      "Collect its result with wait_agent.",
    parameters: spawnSchema,
    execute: async (_toolCallId, params) => {
      const report = manager.spawn(params.name, params.task);
      return {
        content: [
          {
            type: "text",
            text:
              `Worker "${report.name}" started (${report.id}). ` +
              `Use wait_agent to collect its report. ${manager.statusLine()}`,
          },
        ],
        details: report,
      };
    },
  };

  const list: AgentTool = {
    name: "list_agents",
    label: "List Agents",
    description: "List sub-agents with their status.",
    parameters: Type.Object({}),
    execute: async () => {
      const reports = manager.reports();
      if (reports.length === 0) {
        return { content: [{ type: "text", text: "No sub-agents have been spawned." }], details: {} };
      }
      const lines = reports.map(
        (report) => `${statusLabel(report.status)} ${report.name} [${report.id}] — ${report.task}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  };

  const waitSchema = Type.Object({
    agent_id: Type.Optional(Type.String({ description: "Worker id or name; omit to wait for all" })),
  });
  const wait: AgentTool<typeof waitSchema> = {
    name: "wait_agent",
    label: "Wait Agents",
    description:
      "Wait until a sub-agent finishes and return its report. Omit agent_id to wait for ALL running workers.",
    parameters: waitSchema,
    execute: async (_toolCallId, params) => {
      const reports = await manager.wait(params.agent_id);
      if (reports.length === 0) {
        return { content: [{ type: "text", text: "Nothing to wait for." }], details: {} };
      }
      const sections = reports.map(
        (report) =>
          `[${statusLabel(report.status)}] ${report.name} (${(report.durationMs / 1000).toFixed(1)}s)\n${report.report}`,
      );
      return { content: [{ type: "text", text: sections.join("\n\n") }], details: {} };
    },
  };

  const closeSchema = Type.Object({
    agent_id: Type.String({ description: "Worker id or name" }),
  });
  const close: AgentTool<typeof closeSchema> = {
    name: "close_agent",
    label: "Close Agent",
    description: "Abort a running sub-agent by id or name.",
    parameters: closeSchema,
    execute: async (_toolCallId, params) => {
      const report = manager.close(params.agent_id);
      return {
        content: [{ type: "text", text: `Worker ${report.name} abort requested.` }],
        details: report,
      };
    },
  };

  return [spawn, list, wait, close];
}
