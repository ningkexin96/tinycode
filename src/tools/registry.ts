import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Central tool registry. Built-in tools, MCP tools, and sub-agent tools all
 * register here so the model sees one uniform tool surface.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool<any>>();

  register(tool: AgentTool<any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool<any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Registration order is preserved for a stable prompt/tool listing. */
  list(): AgentTool<any>[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
