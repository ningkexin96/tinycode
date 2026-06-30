import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, dataHome, projectTinyDir } from "../src/config/loader.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-config-"));
  delete process.env.TINYCODE_MODEL;
  delete process.env.TINYCODE_PERMISSION_MODE;
});

describe("config loader", () => {
  it("returns an empty config when no file exists", () => {
    const { config, warnings } = loadConfig(root);
    expect(config).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("parses a full config file", () => {
    fs.mkdirSync(path.join(root, ".tinycode"));
    fs.writeFileSync(
      path.join(root, ".tinycode", "config.json"),
      JSON.stringify({
        provider: "anthropic",
        model: "claude-sonnet-4",
        permissionMode: "auto",
        context: { maxToolResultChars: 1234 },
        mcpServers: { example: { command: "node", args: ["server.js"] } },
      }),
    );
    const { config, warnings } = loadConfig(root);
    expect(warnings).toEqual([]);
    expect(config.provider).toBe("anthropic");
    expect(config.permissionMode).toBe("auto");
    expect(config.context?.maxToolResultChars).toBe(1234);
    expect(config.mcpServers?.example?.command).toBe("node");
  });

  it("reports schema violations as warnings instead of crashing", () => {
    fs.mkdirSync(path.join(root, ".tinycode"));
    fs.writeFileSync(path.join(root, ".tinycode", "config.json"), "{ permissionMode: 'sometimes' }");
    const { warnings } = loadConfig(root);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("environment overrides the file; TINYCODE_MODEL parses provider/model", () => {
    fs.mkdirSync(path.join(root, ".tinycode"));
    fs.writeFileSync(
      path.join(root, ".tinycode", "config.json"),
      JSON.stringify({ provider: "anthropic", model: "claude-a", permissionMode: "ask" }),
    );
    process.env.TINYCODE_MODEL = "openai/gpt-5";
    process.env.TINYCODE_PERMISSION_MODE = "auto";
    const { config } = loadConfig(root);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-5");
    expect(config.permissionMode).toBe("auto");
  });

  it("warns when config.json contains secret-looking fields", () => {
    fs.mkdirSync(path.join(root, ".tinycode"));
    fs.writeFileSync(
      path.join(root, ".tinycode", "config.json"),
      JSON.stringify({ provider: "openrouter", apiKey: "sk-or-v1-abc123", mcpServers: { s: { command: "x" } } }),
    );
    const { warnings } = loadConfig(root);
    expect(warnings.join(" ")).toMatch(/look like API keys/);
    expect(warnings.join(" ")).toContain('"apiKey"');
    // The file itself must stay git-ignored-safe: schema still parses the rest.
  });

  it("warns on nested sk-prefixed values even with innocuous field names", () => {
    fs.mkdirSync(path.join(root, ".tinycode"));
    fs.writeFileSync(
      path.join(root, ".tinycode", "config.json"),
      JSON.stringify({ provider: "openrouter", note: "sk-v1-hidden-in-text" }),
    );
    const { warnings } = loadConfig(root);
    expect(warnings.join(" ")).toMatch(/look like API keys/);
  });

  it("ignores TINYCODE_MODEL=mock (handled by the registry)", () => {
    process.env.TINYCODE_MODEL = "mock";
    const { config } = loadConfig(root);
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
  });
});

describe("paths", () => {
  it("dataHome honors TINYCODE_HOME redirect", () => {
    process.env.TINYCODE_HOME = "/tmp/tc-home-test";
    expect(dataHome()).toBe("/tmp/tc-home-test");
    delete process.env.TINYCODE_HOME;
    expect(dataHome()).toContain(".tinycode");
  });

  it("projectTinyDir nests under the project root", () => {
    expect(projectTinyDir("/work/app")).toBe(path.join("/work/app", ".tinycode"));
  });
});
