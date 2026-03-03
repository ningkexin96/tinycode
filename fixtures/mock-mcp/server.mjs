import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Deterministic MCP stdio server used by integration tests.
 * Exposes two tools: `echo` and `fail`.
 */
const server = new McpServer({ name: "test-mcp", version: "1.0.0" });

server.tool("echo", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text: `echo:${text}` }],
}));

server.tool("fail", {}, async () => ({
  content: [{ type: "text", text: "boom" }],
  isError: true,
}));

await server.connect(new StdioServerTransport());
// Keep the event loop alive; the client terminates us via transport close.
setInterval(() => {}, 60_000);
