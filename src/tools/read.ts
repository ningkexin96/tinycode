import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import fs from "node:fs";
import { displayPath, resolveWorkspacePath } from "./paths.js";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const readSchema = Type.Object({
  path: Type.String({ description: "File path relative to the project root" }),
  offset: Type.Optional(Type.Number({ description: "1-based first line to read (default 1)" })),
  limit: Type.Optional(
    Type.Number({ description: `Number of lines to return (default ${DEFAULT_LIMIT})` }),
  ),
});

export interface ReadDetails {
  path: string;
  totalLines: number;
  offset: number;
  returnedLines: number;
  hasMore: boolean;
}

/**
 * read(path, offset?, limit?) — numbered, windowed file reading.
 *
 * Model-friendly properties:
 * - line numbers included so edit anchors are copyable from output;
 * - very long lines are clipped;
 * - large files return a bounded window with explicit continuation hints;
 * - errors are actionable sentences, never raw stack traces.
 */
export function createReadTool(projectRoot: string): AgentTool<typeof readSchema> {
  return {
    name: "read",
    label: "Read",
    description:
      "Read a text file. Returns content with line numbers. Use offset/limit for windows of large files; " +
      "the result states whether more lines remain.",
    parameters: readSchema,
    execute: async (_toolCallId, params) => {
      const absolute = resolveWorkspacePath(projectRoot, params.path);

      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`File not found: ${displayPath(projectRoot, absolute)}`);
        if (code === "EACCES") throw new Error(`Permission denied: ${displayPath(projectRoot, absolute)}`);
        throw new Error(`Cannot stat ${displayPath(projectRoot, absolute)}: ${(error as Error).message}`);
      }
      if (stat.isDirectory()) {
        throw new Error(
          `Not a file (it is a directory): ${displayPath(projectRoot, absolute)}. Use ls to list it.`,
        );
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(
          `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${displayPath(projectRoot, absolute)}. ` +
            `Use bash (head/tail/grep) or narrower reads instead.`,
        );
      }

      const content = fs.readFileSync(absolute, "utf8");
      if (content.includes("\0")) {
        throw new Error(
          `Binary file: ${displayPath(projectRoot, absolute)}. Reading binary content is not supported.`,
        );
      }

      const allLines = content.split("\n");
      // Trailing newline produces a phantom empty final element.
      if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();

      const totalLines = allLines.length;
      const offset = Math.max(1, Math.floor(params.offset ?? 1));
      const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT));
      const start = offset - 1;
      const slice = allLines.slice(start, start + limit);

      const rendered = slice.map((line, index) => {
        const number = start + index + 1;
        const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
        return `${String(number).padStart(6)}│ ${text}`;
      });

      const hasMore = start + limit < totalLines;
      const header = `${displayPath(projectRoot, absolute)} (${totalLines} lines${
        totalLines === 0 ? "" : `, showing ${start + 1}-${start + slice.length}`
      })`;
      const footer =
        totalLines === 0
          ? "(empty file)"
          : hasMore
            ? `… ${totalLines - (start + slice.length)} more lines — continue with offset ${start + limit + 1}`
            : "";

      const details: ReadDetails = {
        path: displayPath(projectRoot, absolute),
        totalLines,
        offset,
        returnedLines: slice.length,
        hasMore,
      };
      return {
        content: [
          {
            type: "text",
            text: [header, ...rendered, footer].filter((line) => line.length > 0).join("\n"),
          },
        ],
        details,
      };
    },
  };
}
