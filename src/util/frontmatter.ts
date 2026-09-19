/**
 * Minimal `---` frontmatter parser/renderer, shared by knowledge articles and
 * skill files. Kept dependency-free on purpose so it stays readable.
 */

export interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

/** Parse a leading `---` frontmatter block of `key: value` lines. */
export function parseFrontmatter(raw: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: match[2]!.trim() };
}

/** Render a frontmatter block from a key → value map (arrays join with `, `). */
export function renderFrontmatter(meta: Record<string, string | string[]>): string {
  const lines = Object.entries(meta).map(
    ([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`,
  );
  return `---\n${lines.join("\n")}\n---\n`;
}
