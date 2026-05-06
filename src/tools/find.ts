import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "./paths.js";
import { walkFiles, globToRegExpSource } from "./walk.js";

const DEFAULT_MAX_RESULTS = 500;

const findSchema = Type.Object({
  pattern: Type.String({ description: 'Glob pattern, e.g. "src/x.ts" or "*.test.ts"' }),
  path: Type.Optional(Type.String({ description: "Directory to search (default: project root)" })),
});

export interface FindDetails {
  pattern: string;
  count: number;
  truncated: boolean;
}

/**
 * find(pattern, path?) — glob search over relative file paths.
 * `**` crosses directories, `*` stays within one, `?` is a single character.
 */
export function createFindTool(projectRoot: string): AgentTool<typeof findSchema> {
  return {
    name: "find",
    label: "Find",
    description:
      'Find files by glob pattern, e.g. "src/**/*.ts" or "*.test.ts". Returns relative paths sorted alphabetically.',
    parameters: findSchema,
    execute: async (_toolCallId, params) => {
      const root = resolveWorkspacePath(projectRoot, params.path ?? ".");
      const regex = new RegExp(`^${globToRegExpSource(params.pattern)}$`);
      const basenameFallback = new RegExp(
        `^${globToRegExpSource(params.pattern.split("/").pop() ?? "*")}$`,
      );

      const found: string[] = [];
      let truncated = false;
      await walkFiles(root, (entry) => {
        const base = entry.relative.split("/").pop() ?? "";
        if (!regex.test(entry.relative) && !basenameFallback.test(base)) return;
        if (found.length >= DEFAULT_MAX_RESULTS) {
          truncated = true;
          return "stop";
        }
        found.push(entry.relative);
      });
      found.sort();

      const header = `${found.length} file${found.length === 1 ? "" : "s"} matching "${params.pattern}"${
        truncated ? ` [truncated at ${DEFAULT_MAX_RESULTS}]` : ""
      }`;
      return {
        content: [{ type: "text", text: found.length > 0 ? `${header}\n${found.join("\n")}` : header }],
        details: { pattern: params.pattern, count: found.length, truncated } satisfies FindDetails,
      };
    },
  };
}
