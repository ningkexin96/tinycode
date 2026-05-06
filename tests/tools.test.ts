import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-tools-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { createReadTool } from "../src/tools/read.js";
import { createWriteTool } from "../src/tools/write.js";
import { createEditTool } from "../src/tools/edit.js";
import { createBashTool } from "../src/tools/bash.js";
import { createGrepTool } from "../src/tools/grep.js";
import { createFindTool } from "../src/tools/find.js";
import { createLsTool } from "../src/tools/ls.js";

function text(result: { content: ReadonlyArray<TextContent | ImageContent> }): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("read tool", () => {
  it("returns numbered lines", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\n");
    const tool = createReadTool(root);
    const result = await tool.execute("t1", { path: "a.txt" });
    const out = text(result);
    expect(out).toContain("1│ one");
    expect(out).toContain("3│ three");
    expect((result.details as { totalLines: number }).totalLines).toBe(3);
  });

  it("supports offset/limit windowing and reports remaining lines", async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    fs.writeFileSync(path.join(root, "b.txt"), content);
    const tool = createReadTool(root);
    const result = await tool.execute("t2", { path: "b.txt", offset: 4, limit: 3 });
    const out = text(result);
    expect(out).toContain("4│ line4");
    expect(out).toContain("6│ line6");
    expect(out).not.toContain("7│ line7");
    expect(out).toContain("offset 7");
    expect((result.details as { hasMore: boolean }).hasMore).toBe(true);
  });

  it("gives friendly errors for missing files and directories", async () => {
    const tool = createReadTool(root);
    await expect(tool.execute("t3", { path: "missing.txt" })).rejects.toThrow(/File not found/);
    await expect(tool.execute("t4", { path: "." })).rejects.toThrow(/directory/);
  });

  it("rejects paths outside the project", async () => {
    const tool = createReadTool(root);
    await expect(tool.execute("t5", { path: "/etc/hosts" })).rejects.toThrow(/resolves outside project/i);
    await expect(tool.execute("t6", { path: "../outside.txt" })).rejects.toThrow(/resolves outside project/i);
  });

  it("detects binary files", async () => {
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    const tool = createReadTool(root);
    await expect(tool.execute("t7", { path: "bin.dat" })).rejects.toThrow(/Binary file/);
  });
});

describe("write tool", () => {
  it("creates new files including parent directories", async () => {
    const tool = createWriteTool(root);
    const result = await tool.execute("w1", { path: "deep/nested/file.txt", content: "hello" });
    expect(fs.readFileSync(path.join(root, "deep/nested/file.txt"), "utf8")).toBe("hello");
    expect((result.details as { created: boolean }).created).toBe(true);
  });

  it("overwrites and reports diff stats", async () => {
    fs.writeFileSync(path.join(root, "f.txt"), "a\nb\n");
    const tool = createWriteTool(root);
    const result = await tool.execute("w2", { path: "f.txt", content: "a\nc\nd\n" });
    expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("a\nc\nd\n");
    const details = result.details as { created: boolean; additions: number; deletions: number };
    expect(details.created).toBe(false);
    expect(details.additions).toBe(2);
    expect(details.deletions).toBe(1);
  });

  it("enforces the project boundary", async () => {
    const tool = createWriteTool(root);
    await expect(tool.execute("w3", { path: "/tmp/evil.txt", content: "x" })).rejects.toThrow(/resolves outside project/i);
  });
});

describe("edit tool", () => {
  it("replaces exact text and returns a diff", async () => {
    fs.writeFileSync(path.join(root, "code.js"), "function add(a,b){\n  return a - b;\n}\n");
    const tool = createEditTool(root);
    const result = await tool.execute("e1", {
      path: "code.js",
      oldText: "return a - b;",
      newText: "return a + b;",
    });
    const out = text(result);
    expect(out).toContain("+   return a + b;");
    expect(out).toContain("-   return a - b;");
    expect(fs.readFileSync(path.join(root, "code.js"), "utf8")).toContain("return a + b;");
  });

  it("fails when oldText is absent", async () => {
    fs.writeFileSync(path.join(root, "x.txt"), "content");
    const tool = createEditTool(root);
    await expect(tool.execute("e2", { path: "x.txt", oldText: "nope", newText: "y" }))
      .rejects.toThrow(/oldText not found/);
  });

  it("fails on multiple matches without replaceAll", async () => {
    fs.writeFileSync(path.join(root, "y.txt"), "dup dup");
    const tool = createEditTool(root);
    await expect(tool.execute("e3", { path: "y.txt", oldText: "dup", newText: "x" }))
      .rejects.toThrow(/matches 2 locations/);
  });

  it("replaceAll replaces every occurrence", async () => {
    fs.writeFileSync(path.join(root, "z.txt"), "dup dup");
    const tool = createEditTool(root);
    await tool.execute("e4", { path: "z.txt", oldText: "dup", newText: "x", replaceAll: true });
    expect(fs.readFileSync(path.join(root, "z.txt"), "utf8")).toBe("x x");
  });
});

describe("bash tool", () => {
  it("captures stdout, stderr and exit codes", async () => {
    const tool = createBashTool(root);
    const ok = await tool.execute("b1", { command: "echo hello" });
    expect(text(ok)).toContain("✓ exit 0");
    expect(text(ok)).toContain("stdout:\nhello");

    const fail = await tool.execute("b2", { command: "echo oops >&2; exit 3" });
    expect(text(fail)).toContain("✗ exit 3");
    expect(text(fail)).toContain("stderr:\noops");
  }, 15000);

  it("runs in the requested cwd inside the project", async () => {
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "marker"), "");
    const tool = createBashTool(root);
    const result = await tool.execute("b3", { command: "ls marker", cwd: "sub" });
    expect(text(result)).toContain("marker");
  }, 15000);

  it("times out long-running commands", async () => {
    const tool = createBashTool(root);
    const result = await tool.execute("b4", { command: "sleep 5", timeoutMs: 300 });
    expect(text(result)).toContain("TIMEOUT");
    expect((result.details as { timedOut: boolean }).timedOut).toBe(true);
  }, 15000);

  it("rejects cwd outside the project", async () => {
    const tool = createBashTool(root);
    await expect(tool.execute("b5", { command: "true", cwd: "/etc" })).rejects.toThrow(/escapes project|outside project/i);
  });
});

describe("grep tool", () => {
  it("finds matches with file:line:text output", async () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const x = 1;\nconst needle = 2;\n");
    fs.writeFileSync(path.join(root, "src", "b.ts"), "needle here\n");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "c.ts"), "needle ignored\n");

    const tool = createGrepTool(root);
    const result = await tool.execute("g1", { pattern: "needle" });
    const out = text(result);
    expect(out).toContain("src/a.ts:2:");
    expect(out).toContain("src/b.ts:1:");
    expect(out).not.toContain("node_modules");
    expect(out.startsWith("2 matches for /needle/")).toBe(true);
  });

  it("honors include glob and ignoreCase", async () => {
    fs.writeFileSync(path.join(root, "a.md"), "NeedleCase\n");
    fs.writeFileSync(path.join(root, "b.txt"), "plain\n");
    const tool = createGrepTool(root);
    const result = await tool.execute("g2", { pattern: "needlecase", include: "*.md", ignoreCase: true });
    expect(text(result)).toContain("a.md:1:");
  });

  it("truncates results at maxResults", async () => {
    fs.writeFileSync(path.join(root, "big.txt"), Array.from({ length: 50 }, (_, i) => `hit ${i}`).join("\n"));
    const tool = createGrepTool(root);
    const result = await tool.execute("g3", { pattern: "hit", maxResults: 5 });
    expect(text(result)).toContain("[results truncated at 5]");
    expect((result.details as { truncated: boolean }).truncated).toBe(true);
  });

  it("reports invalid regex as a friendly error", async () => {
    const tool = createGrepTool(root);
    await expect(tool.execute("g4", { pattern: "([" })).rejects.toThrow(/Invalid regular expression/);
  });
});

describe("find tool", () => {
  it("matches glob patterns across directories", async () => {
    fs.mkdirSync(path.join(root, "src/nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/nested/a.test.ts"), "");
    fs.writeFileSync(path.join(root, "src/b.ts"), "");
    fs.writeFileSync(path.join(root, "README.md"), "");

    const tool = createFindTool(root);
    const tests = text(await tool.execute("f1", { pattern: "**/*.test.ts" }));
    expect(tests).toContain("src/nested/a.test.ts");

    const allTs = text(await tool.execute("f2", { pattern: "src/**/*.ts" }));
    expect(allTs).toContain("src/b.ts");
    expect(allTs).toContain("src/nested/a.test.ts");
    expect(allTs).not.toContain("README.md");
  });
});

describe("ls tool", () => {
  it("lists dirs first with type markers", async () => {
    fs.mkdirSync(path.join(root, "subdir"));
    fs.writeFileSync(path.join(root, "file.txt"), "12345678");
    const tool = createLsTool(root);
    const result = await tool.execute("l1", {});
    const lines = text(result).split("\n");
    expect(lines[0]).toContain("(2 entries)");
    expect(lines[1]!.startsWith("d ")).toBe(true);
    expect(lines[1]).toContain("subdir/");
    expect(lines[2]!.startsWith("f ")).toBe(true);
    expect(lines[2]).toContain("8B");
  });

  it("hides dotfiles unless all=true", async () => {
    fs.writeFileSync(path.join(root, ".hidden"), "");
    fs.writeFileSync(path.join(root, "visible.txt"), "");
    const tool = createLsTool(root);
    const hidden = await tool.execute("l2", {});
    expect(text(hidden)).not.toContain(".hidden");
    const all = await tool.execute("l3", { all: true });
    expect(text(all)).toContain(".hidden");
  });
});
