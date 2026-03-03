import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, loadSkillFile, parseFrontmatter } from "../src/skills/loader.js";
import { SkillRegistry, createLoadSkillTool } from "../src/skills/registry.js";

const sampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/sample-project");

describe("frontmatter parsing", () => {
  it("extracts key/value pairs and body", () => {
    const { meta, body } = parseFrontmatter("---\nname: review\ndescription: Does reviews.\n---\n\n# Body\nsteps here");
    expect(meta.name).toBe("review");
    expect(meta.description).toBe("Does reviews.");
    expect(body).toContain("# Body");
  });

  it("handles files without frontmatter", () => {
    const { meta, body } = parseFrontmatter("just text");
    expect(meta).toEqual({});
    expect(body).toBe("just text");
  });
});

describe("skill discovery", () => {
  it("finds skills in the fixture project", () => {
    const skills = discoverSkills(path.join(sampleRoot, ".tinycode", "skills"));
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("code-review");
    expect(skills[0]!.description).toContain("Review code changes");
    expect(skills[0]!.body).toContain("1. Read the changed files");
  });

  it("returns empty for missing directories", () => {
    expect(discoverSkills(path.join(sampleRoot, "nope"))).toEqual([]);
  });

  it("loadSkillFile tolerates unreadable paths", () => {
    expect(loadSkillFile(path.join(sampleRoot, "missing", "SKILL.md"))).toBeUndefined();
  });
});

describe("SkillRegistry", () => {
  it("discovers from a project root and loads on demand", () => {
    const registry = new SkillRegistry();
    const discovered = registry.discover(sampleRoot);
    expect(discovered.map((s) => s.name)).toEqual(["code-review"]);
    expect(registry.summary()).toEqual([
      { name: "code-review", description: "Review code changes for correctness and maintainability." },
    ]);
    expect(registry.get("code-review")!.body).toContain("# Code Review Skill");
    expect(registry.get("unknown")).toBeUndefined();
  });
});

describe("load_skill tool", () => {
  it("returns the full skill body for valid names", async () => {
    const registry = new SkillRegistry();
    registry.discover(sampleRoot);
    const tool = createLoadSkillTool(registry);
    const result = await tool.execute("t1", { name: "code-review" });
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    expect(text).toContain("# Code Review Skill");
    expect((result.details as { skill: string }).skill).toBe("code-review");
  });

  it("lists available skills when the name is unknown", async () => {
    const registry = new SkillRegistry();
    registry.discover(sampleRoot);
    const tool = createLoadSkillTool(registry);
    await expect(tool.execute("t2", { name: "bogus" })).rejects.toThrow(/Available skills: code-review/);
  });
});
