import { readdir } from "node:fs/promises";
import path from "node:path";

/** Directories never worth searching for source code. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage",
  ".tmp", ".next", ".cache", "__pycache__", ".venv", "venv",
]);

export interface WalkEntry {
  absolute: string;
  relative: string;
}

/**
 * Recursively walk a directory yielding files (not dirs).
 * Skips dependency/build and hidden directories; symlinks are not followed.
 */
export async function walkFiles(
  root: string,
  onEntry: (entry: WalkEntry) => "stop" | void,
): Promise<void> {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip silently
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          queue.push(path.join(dir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (onEntry({ absolute, relative }) === "stop") return;
    }
  }
}

/**
 * Convert a glob into a regular-expression source string.
 * `**` crosses directory boundaries, `*` stays within one segment,
 * `?` matches a single non-separator character.
 */
export function globToRegExpSource(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**` matches any number of path segments.
        if (glob[index + 2] === "/") {
          out += "(?:.*/)?";
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}
