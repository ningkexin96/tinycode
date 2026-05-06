import fs from "node:fs";
import path from "node:path";
import { resolveToolPath } from "../permissions/rules.js";

/**
 * Workspace path guard.
 *
 * Lexical checks (`path.resolve` + `path.relative`) cannot see through
 * symlinks, so a project-relative path like `link -> /etc/hosts` passes them
 * while actually touching files outside the workspace. This guard
 * canonicalizes both sides before comparing:
 *
 *   lexical path → absolute → realpath of existing target (or of the nearest
 *   existing ancestor) → compare against realpath of the project root.
 *
 * This is a path guard, not an OS sandbox: bash commands can still touch
 * anything the user's shell can. The permission layer approves those.
 */
export class PathOutsideProjectError extends Error {
  constructor(display: string) {
    super(`Path resolves outside project directory: ${display}`);
    this.name = "PathOutsideProjectError";
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Nearest existing ancestor of `absolute`, canonicalized. */
function nearestExistingReal(absolute: string): { real: string; suffix: string } {
  let current = absolute;
  for (;;) {
    try {
      return { real: fs.realpathSync(current), suffix: path.relative(current, absolute) };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Unresolvable path: ${absolute}`);
      current = parent;
    }
  }
}

/**
 * Resolve a user-supplied path and enforce the real workspace boundary.
 * Returns an absolute (lexical) path that is safe to hand to node:fs:
 * every component that already exists resolves inside the canonical project
 * root, so new files can only be created under such components.
 */
export function resolveWorkspacePath(projectRoot: string, raw: string | undefined): string {
  const { absolute } = resolveToolPath(projectRoot, raw);
  const realRoot = fs.realpathSync(projectRoot);

  // Existing entries: compare their true location through symlinks.
  try {
    const realTarget = fs.realpathSync(absolute);
    if (!isInside(realRoot, realTarget)) {
      throw new PathOutsideProjectError(displayRaw(projectRoot, raw));
    }
    return absolute;
  } catch (error) {
    if (error instanceof PathOutsideProjectError) throw error;
    // fall through: path does not exist (yet)
  }

  // Broken symlink pointing nowhere: reject explicitly — creating through it
  // would follow the link outside the workspace.
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    // genuinely absent
  }
  if (stat?.isSymbolicLink()) {
    throw new Error(
      `Path resolves outside project directory: ${displayRaw(projectRoot, raw)} (broken symlink target does not exist)`,
    );
  }

  // New file/directory: every existing ancestor must live in the workspace,
  // which rules out symlinked directories pointing elsewhere.
  const { real } = nearestExistingReal(absolute);
  if (!isInside(realRoot, real)) {
    throw new PathOutsideProjectError(displayRaw(projectRoot, raw));
  }
  return absolute;
}

function displayRaw(projectRoot: string, raw: string | undefined): string {
  if (!raw || raw.length === 0) return ".";
  const { absolute } = resolveToolPath(projectRoot, raw);
  const relative = path.relative(projectRoot, absolute);
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

/** Relative display path (what the model should use in later calls). */
export function displayPath(projectRoot: string, absolute: string): string {
  const relative = path.relative(projectRoot, absolute);
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}
