import { z } from "zod";

/**
 * MCP server definition: TinyCode v1 supports stdio servers only.
 * The child process speaks JSON-RPC over stdin/stdout.
 */
export const mcpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  /** Seconds to wait for initialize before marking the server failed. */
  timeoutMs: z.number().int().positive().max(120000).optional(),
});

export const configSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /** Cap on per-request output tokens (helps with prepaid credit limits). */
  maxOutputTokens: z.number().int().positive().max(200000).optional(),
  /** "ask" shows the permission dialog; "auto" approves everything (tests/CI). */
  permissionMode: z.enum(["ask", "auto"]).optional(),
  context: z
    .object({
      /** Soft budget in estimated tokens before auto-compaction kicks in. */
      compactAboveTokens: z.number().int().positive().optional(),
      /** Number of recent messages (plus their tool results) compaction always keeps verbatim. */
      keepRecentMessages: z.number().int().min(2).optional(),
      /** Max characters for a single tool result kept in the transcript. */
      maxToolResultChars: z.number().int().positive().optional(),
    })
    .optional(),
  mcpServers: z.record(mcpServerSchema).optional(),
});

export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type TinyCodeConfig = z.infer<typeof configSchema>;
