/**
 * Minimal line-based diff used by the edit tool and TUI rendering.
 * LCS on lines — fine for source files of typical size; intentionally
 * dependency-free so beginners can read it.
 */

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

/** Longest-common-subsequence table diff. */
export function lineDiff(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = LCS length of before[i..] vs after[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      lines.push({ type: "ctx", text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ type: "del", text: before[i]! });
      i++;
    } else {
      lines.push({ type: "add", text: after[j]! });
      j++;
    }
  }
  while (i < n) lines.push({ type: "del", text: before[i++]! });
  while (j < m) lines.push({ type: "add", text: after[j++]! });
  return lines;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === "add") additions++;
    else if (line.type === "del") deletions++;
  }
  return { additions, deletions };
}

/** Collapse long runs of unchanged context into hunks with context padding. */
export function toHunks(lines: readonly DiffLine[], context = 3): DiffLine[][] {
  const hunks: DiffLine[][] = [];
  let current: DiffLine[] = [];
  let pendingContext: DiffLine[] = [];
  let sawChange = false;

  const flush = () => {
    if (sawChange && current.length > 0) hunks.push(current);
    current = [];
    pendingContext = [];
    sawChange = false;
  };

  lines.forEach((line, index) => {
    if (line.type === "ctx") {
      if (sawChange) current.push(line);
      else pendingContext.push(line);
      // Trim leading context to `context` lines.
      if (!sawChange && pendingContext.length > context) pendingContext.shift();
    } else {
      if (!sawChange && pendingContext.length > 0 && hunks.length > 0) flush();
      current.push(...pendingContext);
      pendingContext = [];
      current.push(line);
      sawChange = true;
    }
    void index;
  });
  if (sawChange) hunks.push(current);
  return hunks;
}

/** Unified-diff-style text with +/- markers, capped to `maxLines`. */
export function renderDiff(lines: readonly DiffLine[], maxLines = 80): string {
  const hunks = toHunks(lines);
  const out: string[] = [];
  let truncated = 0;
  for (const hunk of hunks) {
    if (out.length > 0) out.push("@@");
    for (const line of hunk) {
      if (out.length >= maxLines) {
        truncated++;
        continue;
      }
      const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
      out.push(`${marker} ${line.text}`);
    }
  }
  if (truncated > 0) out.push(`… (${truncated} more diff lines)`);
  return out.join("\n");
}
