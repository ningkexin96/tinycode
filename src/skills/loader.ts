import fs from "node:fs";
import path from "node:path";

/**
 * Skills are folders under `.tinycode/skills/<name>/SKILL.md`.
 * Frontmatter carries `name` and `description`; the markdown body holds the
 * full instructions loaded on demand (progressive disclosure).
 */
export interface Skill {
  name: string;
  description: string;
  path: string;
  /** Markdown body after frontmatter. */
  body: string;
}

/** Parse a leading `---` frontmatter block of `key: value` lines. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
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

export function loadSkillFile(skillFile: string): Skill | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(skillFile, "utf8");
  } catch {
    return undefined;
  }
  const { meta, body } = parseFrontmatter(raw);
  const fallbackName = path.basename(path.dirname(skillFile));
  return {
    name: meta.name || fallbackName,
    description: meta.description || "",
    path: skillFile,
    body,
  };
}

/** Discover skills in one root directory (non-recursive: <root>/<skill>/SKILL.md). */
export function discoverSkills(root: string): Skill[] {
  const skills: Skill[] = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = loadSkillFile(path.join(root, entry.name, "SKILL.md"));
    if (skill && skill.body.length > 0) skills.push(skill);
  }
  return skills;
}
