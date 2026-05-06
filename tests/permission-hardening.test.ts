import { describe, expect, it, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findHardDeny, evaluateRules } from "../src/permissions/rules.js";
import { PermissionManager } from "../src/permissions/manager.js";
import { bootstrapHarness, type Harness } from "../src/bootstrap.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

/**
 * Hardening regressions for non-interactive permission semantics:
 *   tinycode -p            → ASK verdicts DENY (no dialog exists)
 *   --permission-mode auto → explicit opt-in restores automation
 *   auto can never bypass hard DENY
 */

const harnesses: Harness[] = [];
afterAll(async () => {
  await Promise.all(harnesses.map((h) => h.shutdown()));
});

async function bootPrintLike(permissionMode: "ask" | "auto", cwd?: string): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-perm-home-"));
  process.env.TINYCODE_HOME = home;
  const project = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "tc-perm-proj-"));
  const harness = await bootstrapHarness({
    projectRoot: project,
    config: { permissionMode },
    mock: true,
  });
  harnesses.push(harness);
  return harness;
}

describe("hard DENY rule", () => {
  it("matches catastrophic commands only", () => {
    for (const command of ["rm -rf /", "rm -rf /* ; echo x", "rm -rf ~", "mkfs.ext4 /dev/sda", "dd if=/0 of=/dev/disk0s1", "chmod -R 777 /"]) {
      expect(findHardDeny(command), command).toBeDefined();
    }
    for (const command of ["rm -rf dist", "rm ./notes.txt", "npm test", "git clean -fdx", "chmod 777 build"]) {
      expect(findHardDeny(command), command).toBeUndefined();
    }
  });

  it("evaluateRules returns deny before any approval path", () => {
    const verdict = evaluateRules({ toolName: "bash", input: { command: "rm -rf /" }, projectRoot: "/" });
    expect(verdict.action).toBe("deny");
  });

  it("auto mode cannot bypass hard DENY", async () => {
    const manager = new PermissionManager({ mode: "auto", projectRoot: "/p" });
    const decision = await manager.check("bash", { command: "rm -rf /" });
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("catastrophic");
  });

  it("remembered patterns and prompts cannot bypass hard DENY either", async () => {
    let prompted = false;
    const manager = new PermissionManager({
      mode: "ask",
      projectRoot: "/p",
      prompt: async () => {
        prompted = true;
        return "always";
      },
    });
    manager.rememberAlways("bash", "rm -rf");
    const decision = await manager.check("bash", { command: "rm -rf /" });
    expect(decision.action).toBe("deny");
    expect(prompted).toBe(false);
  });
});

describe("headless (-p style) permission semantics", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-headless-"));
    process.env.TINYCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tc-headless-home-"));
    // TINYCODE_PERMISSION_MODE must not leak an implicit auto into these tests.
    delete process.env.TINYCODE_PERMISSION_MODE;
  });

  it("safe commands still execute when defaulting to ask", async () => {
    const harness = await bootPrintLike("ask", workdir);
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "git status || true; echo SAFE-RAN" })]),
      fauxAssistantMessage("The safe command ran."),
    ]);
    await harness.runtime.prompt("run a safe read-only command");

    const results = harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);
    expect(JSON.stringify(results[0]!.content)).toContain("exit 0");
    expect(JSON.stringify(results[0]!.content)).toContain("SAFE-RAN");
  }, 30000);

  it("ASK operations are denied without any dialog", async () => {
    const harness = await bootPrintLike("ask", workdir);
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "npm install left-pad" })]),
      fauxAssistantMessage("I could not install the package because permission was denied."),
    ]);
    await harness.runtime.prompt("install left-pad");

    const results = harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(JSON.stringify(results[0]!.content)).toMatch(/Permission denied|no permission prompt/);

    // Nothing was actually installed in the workspace.
    expect(fs.existsSync(path.join(workdir, "node_modules"))).toBe(false);
  }, 30000);

  it("destructive commands are denied headlessly too", async () => {
    const harness = await bootPrintLike("ask", workdir);
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf dist" })]),
      fauxAssistantMessage("Deletion was refused."),
    ]);
    await harness.runtime.prompt("remove dist");

    const results = harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
    expect(results[0]!.isError).toBe(true);
  }, 30000);

  it("explicit auto mode still approves ASK operations (opt-in preserved)", async () => {
    fs.writeFileSync(path.join(workdir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }, null, 2));
    const harness = await bootPrintLike("auto", workdir);
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("edit", { path: "package.json", oldText: '"name": "x"', newText: '"name": "y"' })]),
      fauxAssistantMessage("Renamed package."),
    ]);
    await harness.runtime.prompt("rename the package");

    const results = harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
    expect(results[0]!.isError).toBe(false);
    expect(fs.readFileSync(path.join(workdir, "package.json"), "utf8")).toContain('"name": "y"');
  }, 30000);

  it("hard deny holds even under explicit auto mode end-to-end", async () => {
    const harness = await bootPrintLike("auto", workdir);
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "mkfs.ext4 /dev/sda" })]),
      fauxAssistantMessage("That command is refused unconditionally."),
    ]);
    await harness.runtime.prompt("format the disk");

    const results = harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
    expect(results[0]!.isError).toBe(true);
    expect(JSON.stringify(results[0]!.content)).toContain("catastrophic");
  }, 30000);
});
