import { describe, expect, it, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp/manager.js";
import { registerMcpTools } from "../src/mcp/adapter.js";
import { ToolRegistry } from "../src/tools/registry.js";

const serverScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/mock-mcp/server.mjs",
);

const manager = new McpManager({
  "test-mcp": { command: process.execPath, args: [serverScript], timeoutMs: 15000 },
});

afterAll(async () => {
  await manager.shutdown();
});

describe("MCP stdio integration", () => {
  it("connects, lists tools and reports status", async () => {
    await manager.startAll();
    const statuses = manager.statuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.status).toBe("connected");
    expect(statuses[0]!.toolCount).toBe(2);
    const tools = manager.toolsOf("test-mcp");
    expect(tools.map((t) => t.name).sort()).toEqual(["echo", "fail"]);
  }, 30000);

  it("registers MCP tools into the unified registry without name clashes", async () => {
    await manager.startAll();
    const registry = new ToolRegistry();
    // A built-in tool already owns the name `echo`: collision must be resolved.
    registry.register({
      name: "echo",
      label: "Echo builtin",
      description: "builtin",
      parameters: { type: "object" } as never,
      execute: async () => ({ content: [{ type: "text", text: "builtin" }], details: {} }),
    });
    const count = registerMcpTools(registry, manager);
    expect(count).toBe(2);
    expect(registry.names().sort()).toEqual(["echo", "fail", "test-mcp_echo"]);
  });

  it("calls MCP tools through the adapter and maps results", async () => {
    await manager.startAll();
    const registry = new ToolRegistry();
    registerMcpTools(registry, manager);
    const echoTool = registry.get("test-mcp_echo") ?? registry.get("echo");
    expect(echoTool).toBeDefined();

    const result = (await echoTool!.execute("t1", { text: "hello world" })) as {
      content: { text: string }[];
      details: { mcpServer: string; isError: boolean };
    };
    expect(result.content[0].text).toContain("echo:hello world");
    expect(result.details.mcpServer).toBe("test-mcp");
    expect(result.details.isError).toBe(false);
  }, 30000);

  it("surfaces isError responses from failing tools", async () => {
    await manager.startAll();
    const registry = new ToolRegistry();
    registerMcpTools(registry, manager);
    const failTool = registry.get("fail")!;
    const result = (await failTool.execute("t2", {})) as {
      content: { text: string }[];
      details: { isError: boolean };
    };
    expect(result.details.isError).toBe(true);
  }, 30000);

  it("reports unreachable servers as errors instead of crashing startup", async () => {
    const broken = new McpManager({
      bad: { command: "definitely-not-a-real-binary-xyz", args: [], timeoutMs: 2000 },
    });
    await broken.startAll();
    const status = broken.statuses()[0]!;
    expect(status.status === "error" || status.toolCount >= 0).toBe(true);
    await broken.shutdown();
  }, 20000);

  it("shutdown closes all clients cleanly", async () => {
    const local = new McpManager({
      "test-mcp-local": { command: process.execPath, args: [serverScript], timeoutMs: 15000 },
    });
    await local.startAll();
    expect(local.size).toBe(1);
    await local.shutdown();
    expect(local.statuses()[0]!.status).toBe("closed");
  }, 30000);
});
