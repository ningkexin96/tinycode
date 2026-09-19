import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, loadSkillFile, parseFrontmatter } from "../src/skills/loader.js";
import { SkillRegistry, createLoadSkillTool } from "../src/skills/registry.js";

const supportDesk = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/support-desk",
);
const skillsDir = path.join(supportDesk, ".tinycode", "skills");

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
  it("finds the triage skills in the support-desk fixture", () => {
    const skills = discoverSkills(skillsDir);
    expect(skills.map((s) => s.name).sort()).toEqual(["escalation-rules", "triage-sop"]);

    const triage = skills.find((s) => s.name === "triage-sop")!;
    expect(triage).toBeDefined();
    expect(triage.description).toContain("工单分流标准流程");
    expect(triage.body).toContain("# 工单分流 SOP");
    expect(triage.body).toContain("list_tickets");
    expect(triage.body).toContain("propose_knowledge_edit");

    const escalation = skills.find((s) => s.name === "escalation-rules")!;
    expect(escalation).toBeDefined();
    expect(escalation.description).toContain("工单升级判断规则");
    expect(escalation.body).toContain("# 升级判断规则");
    expect(escalation.body).toContain("escalate_ticket");
  });

  it("returns empty for missing directories", () => {
    expect(discoverSkills(path.join(supportDesk, "nope"))).toEqual([]);
  });

  it("loadSkillFile tolerates unreadable paths", () => {
    expect(loadSkillFile(path.join(supportDesk, "missing", "SKILL.md"))).toBeUndefined();
  });
});

describe("SkillRegistry", () => {
  it("discovers from the support-desk project root and loads on demand", () => {
    const registry = new SkillRegistry();
    const discovered = registry.discover(supportDesk);
    expect(discovered.map((s) => s.name).sort()).toEqual(["escalation-rules", "triage-sop"]);
    expect(registry.size).toBe(2);

    // Progressive disclosure: the summary carries names + descriptions only.
    const summary = registry.summary();
    expect(summary.map((s) => s.name).sort()).toEqual(["escalation-rules", "triage-sop"]);
    expect(summary.find((s) => s.name === "triage-sop")!.description).toContain("工单分流标准流程");

    expect(registry.get("triage-sop")!.body).toContain("# 工单分流 SOP");
    expect(registry.get("escalation-rules")!.body).toContain("# 升级判断规则");
    expect(registry.get("unknown")).toBeUndefined();
  });
});

describe("load_skill tool", () => {
  function makeTool() {
    const registry = new SkillRegistry();
    registry.discover(supportDesk);
    return createLoadSkillTool(registry);
  }

  it("returns the full skill body for valid names", async () => {
    const tool = makeTool();

    const triage = await tool.execute("t1", { name: "triage-sop" });
    const triageText = triage.content.map((part) => ("text" in part ? part.text : "")).join("");
    expect(triageText).toContain("# 工单分流 SOP");
    expect(triageText).toContain("classify_ticket");
    expect((triage.details as { skill: string }).skill).toBe("triage-sop");

    const escalation = await tool.execute("t2", { name: "escalation-rules" });
    const escalationText = escalation.content.map((part) => ("text" in part ? part.text : "")).join("");
    expect(escalationText).toContain("# 升级判断规则");
    expect(escalationText).toContain("escalate_ticket");
    expect((escalation.details as { skill: string }).skill).toBe("escalation-rules");
  });

  it("lists available skills when the name is unknown", async () => {
    const tool = makeTool();
    await expect(tool.execute("t3", { name: "bogus" })).rejects.toThrow(/Unknown skill "bogus"/);
    await expect(tool.execute("t4", { name: "bogus" })).rejects.toThrow(/triage-sop/);
  });
});
