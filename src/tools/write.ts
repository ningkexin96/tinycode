import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import { diffStats, lineDiff } from "./diff.js";
import { displayPath, resolveWorkspacePath } from "./paths.js";

const writeSchema = Type.Object({
  path: Type.String({ description: "File path relative to the project root" }),
  content: Type.String({ description: "Full file content to write (UTF-8)" }),
});

export interface WriteDetails {
  path: string;
  created: boolean;
  bytes: number;
  additions: number;
  deletions: number;
}

/**
 * write(path, content) — create or overwrite, creating parent directories.
 */
export function createWriteTool(projectRoot: string): AgentTool<typeof writeSchema> {
  return {
    name: "write",
    label: "Write",
    description:
      "Create or overwrite a file inside the project. Parent directories are created automatically. " +
      "Overwriting an existing file replaces its whole content.",
    parameters: writeSchema,
    execute: async (_toolCallId, params) => {
      const absolute = resolveWorkspacePath(projectRoot, params.path);
      const existed = fs.existsSync(absolute);
      const previousLines =
        existed && fs.statSync(absolute).isFile()
          ? fs.readFileSync(absolute, "utf8").split("\n")
          : [];

      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, params.content, "utf8");
      } catch (error) {
        throw new Error(`Failed to write ${displayPath(projectRoot, absolute)}: ${(error as Error).message}`);
      }

      const newLines = params.content.split("\n");
      const stats = diffStats(lineDiff(previousLines, newLines));
      const details: WriteDetails = {
        path: displayPath(projectRoot, absolute),
        created: !existed,
        bytes: Buffer.byteLength(params.content, "utf8"),
        additions: stats.additions,
        deletions: stats.deletions,
      };
      const verb = existed ? "Overwrote" : "Created";
      return {
        content: [
          {
            type: "text",
            text: `${verb} ${details.path}: ${newLines.length} lines, +${stats.additions} -${stats.deletions}`,
          },
        ],
        details,
      };
    },
  };
}
