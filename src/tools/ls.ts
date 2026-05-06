import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import { displayPath, resolveWorkspacePath } from "./paths.js";

const MAX_ENTRIES = 500;

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: project root)" })),
  all: Type.Optional(Type.Boolean({ description: "Include hidden entries (dotfiles)" })),
});

export interface LsDetails {
  path: string;
  count: number;
  truncated: boolean;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * ls(path?, all?) — compact directory listing, dirs first, sizes included.
 */
export function createLsTool(projectRoot: string): AgentTool<typeof lsSchema> {
  return {
    name: "ls",
    label: "List",
    description:
      "List a directory. Shows entry type (d=dir, f=file, l=symlink) and file size. " +
      "Hidden entries require `all: true`.",
    parameters: lsSchema,
    execute: async (_toolCallId, params) => {
      const absolute = resolveWorkspacePath(projectRoot, params.path ?? ".");
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(absolute, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`Directory not found: ${displayPath(projectRoot, absolute)}`);
        if (code === "ENOTDIR") {
          throw new Error(`Not a directory: ${displayPath(projectRoot, absolute)}. Use read for files.`);
        }
        throw new Error(`Failed to list ${displayPath(projectRoot, absolute)}: ${(error as Error).message}`);
      }

      const visible = dirents
        .filter((entry) => params.all === true || !entry.name.startsWith("."))
        .sort((a, b) => {
          const dirDelta = Number(b.isDirectory()) - Number(a.isDirectory());
          return dirDelta !== 0 ? dirDelta : a.name.localeCompare(b.name);
        });

      const truncated = visible.length > MAX_ENTRIES;
      const shown = truncated ? visible.slice(0, MAX_ENTRIES) : visible;
      const lines = shown.map((entry) => {
        const kind = entry.isSymbolicLink() ? "l" : entry.isDirectory() ? "d" : "f";
        let size = "";
        if (kind === "f") {
          try {
            size = humanSize(fs.statSync(path.join(absolute, entry.name)).size);
          } catch {
            size = "?";
          }
        }
        const suffix = entry.isDirectory() ? "/" : "";
        return `${kind} ${size.padStart(8)}  ${entry.name}${suffix}`;
      });

      const header = `${displayPath(projectRoot, absolute)}/ (${visible.length} entr${
        visible.length === 1 ? "y" : "ies"
      })${truncated ? ` [showing first ${MAX_ENTRIES}]` : ""}`;
      return {
        content: [
          { type: "text", text: lines.length > 0 ? `${header}\n${lines.join("\n")}` : `${header} — empty` },
        ],
        details: { path: displayPath(projectRoot, absolute), count: visible.length, truncated } satisfies LsDetails,
      };
    },
  };
}
