import type { McpServerConfig } from "../config/schema.js";
import { McpClient, type McpConnectionState, type McpToolInfo } from "./client.js";

export interface McpServerStatus {
  name: string;
  status: McpConnectionState;
  toolCount: number;
  error?: string;
  command: string;
}

/**
 * Owns the lifecycle of every configured MCP server: connect on startup,
 * cache tool lists, expose status for /mcp, and shut everything down cleanly.
 */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly toolCache = new Map<string, McpToolInfo[]>();

  constructor(servers: Record<string, McpServerConfig>) {
    for (const [name, config] of Object.entries(servers)) {
      this.clients.set(name, new McpClient(name, config));
    }
  }

  get size(): number {
    return this.clients.size;
  }

  /** Connect all servers in parallel; failures are recorded, never thrown. */
  async startAll(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        await client.connect();
        if (client.status === "connected") {
          this.toolCache.set(client.serverName, await client.listTools());
        }
      }),
    );
  }

  /** Status snapshot for UI rendering. */
  statuses(): McpServerStatus[] {
    return [...this.clients.values()].map((client) => ({
      name: client.serverName,
      status: client.status,
      toolCount: this.toolCache.get(client.serverName)?.length ?? 0,
      error: client.error,
      command: "",
    }));
  }

  clientsList(): McpClient[] {
    return [...this.clients.values()];
  }

  toolsOf(serverName: string): McpToolInfo[] {
    return this.toolCache.get(serverName) ?? [];
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>) {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`Unknown MCP server "${serverName}"`);
    return client.callTool(toolName, args);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
  }
}
