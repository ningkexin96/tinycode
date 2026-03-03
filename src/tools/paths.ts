import path from "node:path";
import { resolveToolPath } from "../permissions/rules.js";

/**
 * Resolve a user-supplied path and enforce the project boundary.
 * Throws a model-friendly error when the path escapes the project root.
 */
export function requirePathInsideProject(projectRoot: string, raw: string | undefined): string {
  const { absolute, insideProject } = resolveToolPath(projectRoot, raw);
  if (!insideProject) {
    throw new Error(
      `Path escapes project directory: ${raw} (project root is ${projectRoot}). ` +
        `Ask the user for approval before accessing files outside the project.`,
    );
  }
  return absolute;
}

/** Relative display path (what the model should use in later calls). */
export function displayPath(projectRoot: string, absolute: string): string {
  const relative = path.relative(projectRoot, absolute);
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}
