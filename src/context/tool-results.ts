import fs from "node:fs";
import path from "node:path";

/**
 * Tool-result size control.
 *
 * Oversized outputs (npm install logs, big greps) get head+tail truncation in
 * the transcript while the full output is preserved as a session artifact file
 * the user can open later.
 */

export interface TruncationResult {
  text: string;
  droppedChars: number;
}

/** Keep head and tail of oversized text with an explicit marker in between. */
export function truncateMiddle(text: string, maxChars: number): TruncationResult {
  if (text.length <= maxChars) return { text, droppedChars: 0 };
  const keep = Math.floor(maxChars / 2);
  const dropped = text.length - keep * 2;
  return {
    text: `${text.slice(0, keep)}\n\n[… ${dropped} characters truncated …]\n\n${text.slice(text.length - keep)}`,
    droppedChars: dropped,
  };
}

/** Persist a full tool output next to the session files. Returns the artifact path. */
export function saveArtifact(artifactsDir: string, toolName: string, text: string): string {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = toolName.replace(/[^\w.-]/g, "_");
  const file = path.join(artifactsDir, `${stamp}-${safeName}.txt`);
  fs.writeFileSync(file, text, "utf8");
  return file;
}
