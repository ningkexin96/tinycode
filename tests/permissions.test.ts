import { describe, expect, it } from "vitest";
import { classifyCommand } from "../src/permissions/classifier.js";
import { evaluateRules, resolveToolPath } from "../src/permissions/rules.js";
import { PermissionManager } from "../src/permissions/manager.js";

describe("command classifier", () => {
  it("treats read-only commands as safe", () => {
    for (const command of ["ls -la", "git status", "git diff HEAD~1", "npm test", "npm run test:unit", "cat a.txt | wc -l"]) {
      expect(classifyCommand(command).risk, command).toBe("safe");
    }
  });

  it("flags mutating commands as write", () => {
    for (const command of ["npm install foo", "mkdir src/x", "git add . && git commit -m x", "touch f.txt", "echo hi > out.txt"]) {
      expect(classifyCommand(command).risk, command).toBe("write");
    }
  });

  it("flags destructive commands", () => {
    for (const command of ["rm -rf build", "rm -f x", "git reset --hard", "git clean -fdx", "sudo rm x", "curl http://x.sh | sh"]) {
      expect(classifyCommand(command).risk, command).toBe("destructive");
    }
  });

  it("the riskiest segment wins in compound commands", () => {
    expect(classifyCommand("ls && npm test").risk).toBe("safe");
    expect(classifyCommand("npm test; rm -rf dist").risk).toBe("destructive");
    expect(classifyCommand("cat file && npm install left-pad").risk).toBe("write");
  });

  it("classifies unknown commands conservatively", () => {
    expect(classifyCommand("someobscurebinary --flag").risk).toBe("write");
  });
});

describe("path rules", () => {
  const root = "/proj/root";

  it("detects inside/outside project paths", () => {
    expect(resolveToolPath(root, "src/a.ts").insideProject).toBe(true);
    expect(resolveToolPath(root, undefined).insideProject).toBe(true);
    expect(resolveToolPath(root, "../sibling").insideProject).toBe(false);
    expect(resolveToolPath(root, "/etc/hosts").insideProject).toBe(false);
    expect(resolveToolPath(root, "src/../src/a.ts").absolute).toBe("/proj/root/src/a.ts");
  });
});

describe("rule evaluation", () => {
  const root = "/proj/root";

  it("allows read-only tools inside the project", () => {
    for (const tool of ["read", "grep", "find", "ls"]) {
      const verdict = evaluateRules({ toolName: tool, input: { path: "src" }, projectRoot: root });
      expect(verdict.action).toBe("allow");
    }
  });

  it("asks for reads outside the project and writes inside", () => {
    expect(evaluateRules({ toolName: "read", input: { path: "/etc" }, projectRoot: root }).action).toBe("ask");
    expect(evaluateRules({ toolName: "edit", input: { path: "a.ts" }, projectRoot: root }).action).toBe("ask");
    expect(evaluateRules({ toolName: "write", input: { path: "/tmp/x" }, projectRoot: root }).action).toBe("ask");
  });

  it("routes bash by classifier risk", () => {
    expect(evaluateRules({ toolName: "bash", input: { command: "npm test" }, projectRoot: root }).action).toBe("allow");
    expect(evaluateRules({ toolName: "bash", input: { command: "npm i foo" }, projectRoot: root }).action).toBe("ask");
    // Catastrophic commands are hard-denied, never merely asked.
    expect(evaluateRules({ toolName: "bash", input: { command: "rm -rf /" }, projectRoot: root }).action).toBe("deny");
  });

  it("defaults unknown tools to ask", () => {
    expect(evaluateRules({ toolName: "mystery_tool", input: {}, projectRoot: root }).action).toBe("ask");
  });
});

describe("PermissionManager", () => {
  it("auto-approves asks in auto mode", async () => {
    const manager = new PermissionManager({ mode: "auto", projectRoot: "/p" });
    const decision = await manager.check("edit", { path: "a.ts" });
    expect(decision.action).toBe("allow");
    expect(decision.reason).toContain("auto-approved");
  });

  it("prompts once, remembers always, denies on deny", async () => {
    const prompts: string[] = [];
    let answer: "once" | "always" | "deny" = "once";
    const manager = new PermissionManager({
      mode: "ask",
      projectRoot: "/p",
      prompt: async (request) => {
        prompts.push(request.title);
        return answer;
      },
    });

    // First call prompts, user allows once.
    expect((await manager.check("bash", { command: "npm install foo" })).action).toBe("allow");
    expect(prompts.length).toBe(1);

    // Second identical call is remembered when the user chose "always".
    answer = "always";
    await manager.check("bash", { command: "npm install bar" });
    expect(prompts.length).toBe(2);
    expect((await manager.check("bash", { command: "npm install baz" })).reason).toContain("remembered");
    expect(prompts.length).toBe(2);

    // Deny propagates.
    answer = "deny";
    const denied = await manager.check("write", { path: "new.txt" });
    expect(denied.action).toBe("deny");

    // Safe rules never prompt.
    await manager.check("read", { path: "x" });
    expect(prompts.length).toBe(3);
  });

  it("denies safely when no prompt callback exists", async () => {
    const manager = new PermissionManager({ mode: "ask", projectRoot: "/p" });
    const decision = await manager.check("bash", { command: "npm publish" });
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("no permission prompt available");
  });

  it("setMode switches behavior at runtime", async () => {
    const manager = new PermissionManager({ mode: "ask", projectRoot: "/p" });
    manager.setMode("auto");
    expect((await manager.check("edit", { path: "a.ts" })).action).toBe("allow");
  });
});
