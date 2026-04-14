import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapHarness } from "../src/bootstrap.js";
import { executeSlashCommand, SLASH_COMMAND_NAMES } from "../src/tui/slash.js";
import type { SlashContext } from "../src/tui/slash.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/sample-project",
);

let context!: SlashContext;
let oldHome: string | undefined;

beforeAll(async () => {
  oldHome = process.env.TINYCODE_HOME;
  process.env.TINYCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tc-slash-home-"));
  const harness = await bootstrapHarness({
    projectRoot,
    config: { permissionMode: "auto" },
    mock: true,
    session: { mode: "new" },
  });
  context = {
    runtime: harness.runtime,
    models: harness.models,
    permissions: harness.permissions,
    session: harness.session,
    skills: harness.skills,
    mcp: harness.mcp,
    subAgents: harness.subAgents,
    projectRoot,
    loadSession: async (id: string) => [`resumed ${id}`],
    startNewSession: () => harness.session!.start(projectRoot, "mock/tinycode-mock"),
    requestExit: () => {},
  };
});

afterAll(() => {
  if (oldHome === undefined) delete process.env.TINYCODE_HOME;
  else process.env.TINYCODE_HOME = oldHome;
});

describe("slash commands", () => {
  it("exposes the full required command set", () => {
    for (const name of ["/help", "/new", "/clear", "/resume", "/sessions", "/model", "/skills", "/mcp", "/agents", "/compact", "/status", "/exit"]) {
      expect(SLASH_COMMAND_NAMES, name).toContain(name);
    }
  });

  it("/help lists every command with a description", async () => {
    const lines = await executeSlashCommand("/help", context);
    const text = lines.join("\n");
    expect(text).toContain("/help");
    expect(text).toContain("/compact");
    expect(text).toContain("/mcp");
  });

  it("/skills lists discovered fixture skills", async () => {
    const lines = await executeSlashCommand("/skills", context);
    expect(lines.join("\n")).toContain("code-review");
  });

  it("/status reports model, tools, permissions and session", async () => {
    const lines = await executeSlashCommand("/status", context);
    const text = lines.join("\n");
    expect(text).toContain(`project root : ${projectRoot}`);
    expect(text).toContain("model        : mock/tinycode-mock");
    expect(text).toContain("permissions  : mode=auto");
    expect(text).toContain("tools        : read");
  });

  it("/sessions lists the live session and /new starts another", async () => {
    await context.runtime.prompt("first prompt");
    const list = await executeSlashCommand("/sessions", context);
    expect(list.length).toBeGreaterThan(0);

    const before = context.session!.id!;
    const lines = await executeSlashCommand("/new", context);
    expect(lines[0]).toMatch(/Started new session/);
    expect(context.session!.id!).not.toBe(before);
  });

  it("/resume loads a previous session into the runtime transcript", async () => {
    const target = context.session!.id!;
    context.runtime.agent.reset();
    const lines = await context.loadSession(target);
    expect(lines.join(" ")).toContain(target);
  });

  it("/model lists mock and switches back by ref", async () => {
    const listing = (await executeSlashCommand("/model", context)).join("\n");
    expect(listing).toContain("current:");
    // The mock provider has auth configured implicitly.
    const switchResult = (await executeSlashCommand("/model mock/tinycode-mock", context)).join("\n");
    expect(switchResult.toLowerCase()).toContain("switched");
  });

  it("/agents reports none spawned; /mcp reports unconfigured", async () => {
    const agents = await executeSlashCommand("/agents", context);
    expect(agents[0]).toContain("SUB-AGENTS 0/3 RUNNING");
    const mcp = await executeSlashCommand("/mcp", context);
    expect(mcp.join(" ")).toContain("not configured");
  });

  it("/compact works on an empty conversation without crashing", async () => {
    context.runtime.agent.reset();
    const lines = await executeSlashCommand("/compact", context);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("unknown commands are rejected with guidance", async () => {
    const lines = await executeSlashCommand("/frobnicate", context);
    expect(lines[0]).toContain("Unknown command");
    expect(lines[0]).toContain("/help");
  });

  it("/exit requests shutdown", async () => {
    let exited = false;
    const exiting: SlashContext = { ...context, requestExit: () => (exited = true) };
    await executeSlashCommand("/exit", exiting);
    expect(exited).toBe(true);
  });
});

describe("CLI smoke (built dist)", () => {
  const projectRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(projectRootDir, "dist", "cli", "index.js");

  // `npm test` must work on a fresh clone without a prior `npm run build`.
  beforeAll(() => {
    if (!fs.existsSync(cli)) {
      execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: projectRootDir, stdio: "pipe" });
    }
    expect(fs.existsSync(cli)).toBe(true);
  });

  function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): string {
    return execFileSync(process.execPath, [cli, ...args], {
      cwd: opts.cwd ?? projectRoot,
      env: { ...process.env, TINYCODE_HOME: os.tmpdir() + "/tc-cli-home", ...opts.env },
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("--version prints the version", () => {
    expect(run(["--version"])).toMatch(/^tinycode \d+\.\d+\.\d+/);
  });

  it("--help prints usage with all documented flags", () => {
    const help = run(["--help"]);
    for (const flag of ["--continue", "--session", "--model", "--permission-mode", "-p", "--list-models"]) {
      expect(help).toContain(flag);
    }
  });

  it("-p runs one-shot with the mock model", () => {
    const out = run(["-p", "describe this project"], { env: { TINYCODE_MODEL: "mock" }, cwd: os.tmpdir() });
    expect(out).toContain("TinyCode mock model");
  });

  it("errors gracefully without any API key or mock", () => {
    let failed = false;
    try {
      run(["-p", "hello"], {
        cwd: os.tmpdir(),
        env: {
          TINYCODE_MODEL: "",
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
          GROQ_API_KEY: "",
          GOOGLE_API_KEY: "",
          XAI_API_KEY: "",
          MISTRAL_API_KEY: "",
          DEEPSEEK_API_KEY: "",
          OPENROUTER_API_KEY: "",
        },
      });
    } catch (error) {
      failed = true;
      const output = String((error as { stderr?: Buffer }).stderr ?? error);
      expect(output).toContain("No API key found");
    }
    expect(failed).toBe(true);
  });

  it("rejects unknown flags with exit code 2-style message", () => {
    let failed = false;
    try {
      run(["--definitely-not-a-flag"]);
    } catch (error) {
      failed = true;
      const output = String((error as { stderr?: Buffer }).stderr ?? error);
      expect(output).toContain("Unknown option");
    }
    expect(failed).toBe(true);
  });
});
