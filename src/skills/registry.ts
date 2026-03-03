import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { discoverSkills, type Skill } from "./loader.js";

/**
 * SkillRegistry discovers skills from project and user directories and
 * exposes progressive disclosure: only name/description enter the system
 * prompt; full bodies are loaded on demand through the load_skill tool.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  /** Discover from a project root plus the user-level data directory. Project wins. */
  discover(projectRoot: string): Skill[] {
    this.skills.clear();
    const userRoot = path.join(os.homedir(), ".tinycode", "skills");
    for (const skill of [...discoverSkills(userRoot), ...discoverSkills(path.join(projectRoot, ".tinycode", "skills"))]) {
      this.skills.set(skill.name, skill);
    }
    return this.list();
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  get size(): number {
    return this.skills.size;
  }

  summary(): { name: string; description: string }[] {
    return this.list().map((skill) => ({ name: skill.name, description: skill.description }));
  }
}

const loadSkillSchema = Type.Object({
  name: Type.String({ description: "Skill name as listed in the system prompt" }),
});

/** Factory for the uniform `load_skill` tool. */
export function createLoadSkillTool(registry: SkillRegistry): AgentTool<typeof loadSkillSchema> {
  return {
    name: "load_skill",
    label: "Load Skill",
    description:
      "Load the full instructions of a discovered skill by name. Use when a listed skill matches the current task.",
    parameters: loadSkillSchema,
    execute: async (_toolCallId, params) => {
      const skill = registry.get(params.name);
      if (!skill) {
        const available = registry.list().map((entry) => entry.name).join(", ");
        throw new Error(
          available.length > 0
            ? `Unknown skill "${params.name}". Available skills: ${available}`
            : `Unknown skill "${params.name}". No skills are installed.`,
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `# Skill: ${skill.name}\n(from ${skill.path})\n\n${skill.body}`,
          },
        ],
        details: { skill: skill.name },
      };
    },
  };
}
