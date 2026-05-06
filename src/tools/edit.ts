import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import fs from "node:fs";
import { diffStats, lineDiff, renderDiff } from "./diff.js";
import { displayPath, resolveWorkspacePath } from "./paths.js";

const editSchema = Type.Object({
  path: Type.String({ description: "File path relative to the project root" }),
  oldText: Type.String({ description: "Exact existing text to replace" }),
  newText: Type.String({ description: "Replacement text" }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace every occurrence instead of failing on multiple matches" }),
  ),
});

export interface EditDetails {
  path: string;
  additions: number;
  deletions: number;
  replacements: number;
  diff: string;
}

/**
 * edit(path, oldText, newText, replaceAll?) — exact-match text replacement.
 *
 * Safety rules:
 * - oldText must exist verbatim (no fuzzy matching);
 * - multiple matches fail unless replaceAll is set, so the model never
 *   silently rewrites an unintended occurrence;
 * - a unified-diff preview of the change is returned for verification.
 */
export function createEditTool(projectRoot: string): AgentTool<typeof editSchema> {
  return {
    name: "edit",
    label: "Edit",
    description:
      "Replace exact text inside a file. `oldText` must match the file content exactly " +
      "(copy it from a previous read, including whitespace). If `oldText` appears more than once, " +
      "include more surrounding lines or pass `replaceAll: true`.",
    parameters: editSchema,
    execute: async (_toolCallId, params) => {
      const absolute = resolveWorkspacePath(projectRoot, params.path);

      let current: string;
      try {
        current = fs.readFileSync(absolute, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new Error(`File not found: ${displayPath(projectRoot, absolute)}. Use write to create it.`);
        }
        if (code === "EISDIR") {
          throw new Error(`Not a file (it is a directory): ${displayPath(projectRoot, absolute)}`);
        }
        throw new Error(`Failed to read ${displayPath(projectRoot, absolute)}: ${(error as Error).message}`);
      }

      if (params.oldText.length === 0) {
        throw new Error("oldText is empty — provide the exact text to replace.");
      }
      const occurrences = current.split(params.oldText).length - 1;
      if (occurrences === 0) {
        throw new Error(
          `oldText not found in ${displayPath(projectRoot, absolute)}. ` +
            `Read the file again and copy the text exactly (whitespace and indentation matter).`,
        );
      }
      if (occurrences > 1 && !params.replaceAll) {
        throw new Error(
          `oldText matches ${occurrences} locations in ${displayPath(projectRoot, absolute)}. ` +
            `Include more surrounding context to make it unique, or pass replaceAll=true.`,
        );
      }

      const updated = params.replaceAll
        ? current.split(params.oldText).join(params.newText)
        : current.replace(params.oldText, params.newText);

      try {
        fs.writeFileSync(absolute, updated, "utf8");
      } catch (error) {
        throw new Error(`Failed to write ${displayPath(projectRoot, absolute)}: ${(error as Error).message}`);
      }

      const diffLines = lineDiff(current.split("\n"), updated.split("\n"));
      const stats = diffStats(diffLines);
      const details: EditDetails = {
        path: displayPath(projectRoot, absolute),
        additions: stats.additions,
        deletions: stats.deletions,
        replacements: params.replaceAll ? occurrences : 1,
        diff: renderDiff(diffLines),
      };
      return {
        content: [
          {
            type: "text",
            text:
              `Edited ${details.path} (${details.replacements} replacement${details.replacements === 1 ? "" : "s"}): ` +
              `+${stats.additions} -${stats.deletions}\n\n${renderDiff(diffLines)}`,
          },
        ],
        details,
      };
    },
  };
}
