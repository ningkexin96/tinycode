import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { statusLabel, type SubAgentManager } from "./manager.js";

/**
 * Root-agent tools for supervising read-only workers.
 * Workers themselves never receive these tools, so recursion is impossible.
 */
export function createSubAgentTools(manager: SubAgentManager): AgentTool[] {
  const spawnSchema = Type.Object({
    name: Type.String({ description: "简短唯一的调研子智能体名称，例如「退款规则核查」" }),
    task: Type.String({ description: "交给子智能体的精确取证任务" }),
  });
  const spawn: AgentTool<typeof spawnSchema> = {
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "派生一个只读调研子智能体（独立上下文）去核查一个聚焦子问题，" +
      "例如「这个工单涉及的退款时效写在知识库哪一篇、原文怎么说」。它只能查询工单与知识库，" +
      "无法修改任何数据。用 wait_agent 收集它的报告。",
    parameters: spawnSchema,
    execute: async (_toolCallId, params) => {
      const report = manager.spawn(params.name, params.task);
      return {
        content: [
          {
            type: "text",
            text:
              `子智能体 "${report.name}" 已启动（${report.id}）。` +
              `用 wait_agent 收集报告。${manager.statusLine()}`,
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
