import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import fs from "node:fs";
import { displayPath, resolveWorkspacePath } from "./paths.js";
import { walkFiles, globToRegExpSource } from "./walk.js";

const DEFAULT_MAX_RESULTS = 100;
const MAX_FILE_BYTES = 1024 * 1024;

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regular expression (JavaScript syntax)" }),
  path: Type.Optional(Type.String({ description: "File or directory to search (default: project root)" })),
  include: Type.Optional(Type.String({ description: 'Filename glob filter, e.g. "*.ts"' })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive matching" })),
  maxResults: Type.Optional(
    Type.Number({ description: `Maximum matches returned (default ${DEFAULT_MAX_RESULTS})` }),
  ),
});

export interface GrepDetails {
  pattern: string;
  matches: number;
  filesSearched: number;
  truncated: boolean;
}

/** Compile a filename glob into a matcher over full relative paths AND basenames. */
function compileGlob(pattern: string): (relativePath: string) => boolean {
  const fullPath = new RegExp(`^${globToRegExpSource(pattern)}$`);
  const base = new RegExp(`^${globToRegExpSource(pattern.split("/").pop() ?? "*")}$`);
  return (relative) => fullPath.test(relative) || base.test(relative.split("/").pop() ?? "");
}

/**
 * grep(pattern, path?, include?, ignoreCase?, maxResults?) — regex search over project text files.
 */
export function createGrepTool(projectRoot: string): AgentTool<typeof grepSchema> {
  return {
    name: "grep",
    label: "Grep",
    description:
      "Search file contents with a JavaScript regular expression. Returns `path:line:text` matches " +
      "(result count capped; raise maxResults if needed). Use `include` to filter by filename glob.",
    parameters: grepSchema,
    execute: async (_toolCallId, params) => {
      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern, params.ignoreCase ? "i" : "");
      } catch (error) {
        throw new Error(`Invalid regular expression "${params.pattern}": ${(error as Error).message}`);
      }
      const matcher = compileGlob(params.include ?? "*");
      const root = resolveWorkspacePath(projectRoot, params.path ?? ".");
      let isFile = false;
      try {
        isFile = fs.statSync(root).isFile();
      } catch {
        throw new Error(`Search path not found: ${displayPath(projectRoot, root)}`);
      }

      const maxResults = Math.max(1, Math.floor(params.maxResults ?? DEFAULT_MAX_RESULTS));
      const outputLines: string[] = [];
      let matches = 0;
      let filesSearched = 0;
      let truncated = false;

      const searchFile = (absolute: string, relative: string): boolean => {
        if (!matcher(relative)) return true;
        let content: string;
        try {
          if (fs.statSync(absolute).size > MAX_FILE_BYTES) return true;
          content = fs.readFileSync(absolute, "utf8");
        } catch {
          return true; // unreadable file: skip
        }
        if (content.includes("\0")) return true; // binary
        filesSearched++;
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (!regex.test(lines[index]!)) continue;
          matches++;
          if (outputLines.length >= maxResults) {
            truncated = true;
            return false;
          }
          outputLines.push(`${relative}:${index + 1}:${lines[index]!.trim().slice(0, 400)}`);
        }
        return true;
      };

      if (isFile) {
        searchFile(root, displayPath(projectRoot, root));
      } else {
        await walkFiles(root, (entry) => {
          if (!searchFile(entry.absolute, entry.relative)) return "stop";
        });
      }

      const header = `${matches} match${matches === 1 ? "" : "es"} for /${params.pattern}/ in ${filesSearched} file${filesSearched === 1 ? "" : "s"}`;
      const body =
        outputLines.length > 0
          ? `\n${outputLines.join("\n")}${truncated ? `\n[results truncated at ${maxResults}]` : ""}`
          : "";
      return {
        content: [{ type: "text", text: `${header}${body}` }],
        details: { pattern: params.pattern, matches, filesSearched, truncated } satisfies GrepDetails,
      };
    },
  };
}
