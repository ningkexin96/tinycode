import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRegistry } from "../tools/registry.js";
import type { McpManager } from "./manager.js";

/**
 * Maps MCP tools into the unified TinyCode ToolRegistry so the model never
 * distinguishes built-in tools from MCP tools.
 *
 * Naming: the plain tool name is used when free; on collision the server name
 * is prefixed (`<server>_<tool>`).
 */
export function registerMcpTools(registry: ToolRegistry, manager: McpManager): number {
  let count = 0;
  for (const client of manager.clientsList()) {
    if (client.status !== "connected") continue;
    for (const tool of manager.toolsOf(client.serverName)) {
      let name = tool.name;
      if (registry.has(name)) name = `${client.serverName}_${name}`;
      if (registry.has(name)) continue; // pathological double collision: skip

      registry.register(mcpToolToAgentTool(name, client.serverName, tool.name, tool.description, tool.inputSchema, manager));
      count++;
    }
  }
  return count;
}

function mcpToolToAgentTool(
  registeredName: string,
  serverName: string,
  remoteName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  manager: McpManager,
): AgentTool<any> {
  return {
    name: registeredName,
    label: `MCP ${serverName}/${remoteName}`,
    description:
      `${description || `MCP tool ${remoteName} from server "${serverName}"`} ` +
      `(MCP tool provided by server "${serverName}")`,
    parameters: normalizeSchema(inputSchema),
    execute: async (_toolCallId, params) => {
      const result = await manager.callTool(serverName, remoteName, params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: result.text }],
        details: { mcpServer: serverName, mcpTool: remoteName, isError: result.isError },
      };
    },
  };
}

/** MCP tools carry JSON Schema; guarantee a minimal object shape. */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const base = schema && typeof schema === "object" ? { ...schema } : {};
  if (base.type !== "object") return { type: "object", properties: {}, additionalProperties: true };
  return base;
}
