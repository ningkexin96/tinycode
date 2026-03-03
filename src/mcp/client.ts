import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../config/schema.js";

/**
 * Thin wrapper around one stdio MCP server connection.
 * All failures are captured as state (`status`/`error`) so one broken server
 * never takes TinyCode down.
 */
export type McpConnectionState = "idle" | "connecting" | "connected" | "error" | "closed";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private _status: McpConnectionState = "idle";
  private _error?: string;

  constructor(
    readonly serverName: string,
    private readonly config: McpServerConfig,
  ) {}

  get status(): McpConnectionState {
    return this._status;
  }

  get error(): string | undefined {
    return this._error;
  }

  /** Connect and initialize with a bounded wait. */
  async connect(): Promise<void> {
    if (this._status === "connected") return;
    this._status = "connecting";
    this._error = undefined;
    const timeoutMs = this.config.timeoutMs ?? 10_000;

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: [...this.config.args],
      env: { ...process.env, ...this.config.env } as Record<string, string>,
      cwd: this.config.cwd,
      stderr: "pipe",
    });
    this.client = new Client({ name: "tinycode", version: "1.0.0" });

    try {
      await Promise.race([
        this.client.connect(this.transport),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`initialize timed out after ${timeoutMs}ms`)), timeoutMs).unref(),
        ),
      ]);
      this._status = "connected";
    } catch (error) {
      this._error = (error as Error).message;
      this._status = "error";
      await this.dispose();
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    this.assertConnected();
    try {
      const response = await this.client!.listTools();
      return (response.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      }));
    } catch (error) {
      this.fail(`listTools failed: ${(error as Error).message}`);
      return [];
    }
  }

  /** Call a tool and flatten its content into model-friendly text. */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    this.assertConnected();
    try {
      const response = await this.client!.callTool({ name: toolName, arguments: args });
      const parts = Array.isArray(response.content) ? response.content : [];
      const textParts: string[] = [];
      let otherTypes = 0;
      for (const part of parts) {
        if (part.type === "text") textParts.push(part.text);
        else otherTypes++;
      }
      if (otherTypes > 0) textParts.push(`[${otherTypes} non-text content block(s) omitted]`);
      return {
        text: textParts.join("\n") || "(empty result)",
        isError: response.isError === true,
      };
    } catch (error) {
      return { text: `MCP tool call failed: ${(error as Error).message}`, isError: true };
    }
  }

  async close(): Promise<void> {
    if (this._status === "closed") return;
    await this.dispose();
    this._status = "closed";
  }

  private fail(message: string): void {
    this._error = message;
    this._status = "error";
  }

  private assertConnected(): void {
    if (this._status !== "connected") {
      throw new Error(`MCP server "${this.serverName}" is not connected (${this._status}${this._error ? `: ${this._error}` : ""})`);
    }
  }

  private async dispose(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // best-effort teardown
    }
    this.client = undefined;
    this.transport = undefined;
  }
}
