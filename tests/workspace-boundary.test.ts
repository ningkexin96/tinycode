import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createReadTool } from "../src/tools/read.js";
import { createWriteTool } from "../src/tools/write.js";
import { createEditTool } from "../src/tools/edit.js";
import { createLsTool } from "../src/tools/ls.js";
import { createBashTool } from "../src/tools/bash.js";
import { resolveWorkspacePath, PathOutsideProjectError } from "../src/tools/paths.js";

/**
 * Symlink workspace-escape regressions.
 * Real symlinks are created; skipped on platforms without symlink support.
 */
const supportsSymlink = (() => {
  try {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sym-probe-"));
    fs.symlinkSync(probe, path.join(probe, "self"), "dir");
    fs.rmSync(probe, { recursive: true });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!supportsSymlink)("workspace boundary vs symlinks", () => {
  let root: string;
  let outsideDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-boundary-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const ok = true;\n");

    // file symlink and directory symlink pointing outside the project
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(root, "outside-link"));
    fs.symlinkSync(outsideDir, path.join(root, "out-dir"));
    // dangling symlink
    fs.symlinkSync(path.join(outsideDir, "does-not-exist.txt"), path.join(root, "dangling-link"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("read through a symlinked file is rejected", async () => {
    const tool = createReadTool(root);
    await expect(tool.execute("t1", { path: "outside-link" })).rejects.toThrow(/resolves outside project/i);
  });

  it("edit through a symlinked file is rejected", async () => {
    const tool = createEditTool(root);
    await expect(
      tool.execute("t2", { path: "outside-link", oldText: "secret", newText: "owned" }),
    ).rejects.toThrow(/resolves outside project/i);
    expect(fs.readFileSync(path.join(outsideDir, "secret.txt"), "utf8")).toBe("top secret\n");
  });

  it("write into a symlinked directory is rejected", async () => {
    const tool = createWriteTool(root);
    await expect(tool.execute("t3", { path: "out-dir/x.txt", content: "nope" }))
      .rejects.toThrow(/resolves outside project/i);
    expect(fs.existsSync(path.join(outsideDir, "x.txt"))).toBe(false);
  });

  it("a broken symlink is rejected instead of being followed on write", async () => {
    const tool = createWriteTool(root);
    await expect(tool.execute("t4", { path: "dangling-link", content: "nope" }))
      .rejects.toThrow(/resolves outside project|broken symlink/i);
    expect(fs.existsSync(path.join(outsideDir, "does-not-exist.txt"))).toBe(false);
  });

  it("ls/grep/find refuse symlinked directories as search roots", () => {
    expect(() => resolveWorkspacePath(root, "out-dir")).toThrow(PathOutsideProjectError);
  });

  it("normal workspace paths keep working (read/write/edit/ls/bash cwd)", async () => {
    const read = createReadTool(root);
    const ok = await read.execute("n1", { path: "src/a.ts" });
    expect(ok.details).toMatchObject({ totalLines: 1 });

    const write = createWriteTool(root);
    await write.execute("n2", { path: "src/new/deep.txt", content: "created" });
    expect(fs.readFileSync(path.join(root, "src/new/deep.txt"), "utf8")).toBe("created");

    const edit = createEditTool(root);
    await edit.execute("n3", { path: "src/a.ts", oldText: "true", newText: "false" });
    expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toContain("false");

    const ls = createLsTool(root);
    const listing = await ls.execute("n4", { path: "src" });
    expect(listing.details).toMatchObject({ count: 2 }); // a.ts + new/

    const bash = createBashTool(root);
    const pwd = await bash.execute("n5", { command: "basename $PWD", cwd: "src/new" });
    const text = pwd.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("new");
  }, 20000);

  it("a symlinked project root itself canonicalizes correctly", async () => {
    // /tmp/link-to-root -> root : tools rooted at the link still work.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tc-root-link-"));
    const linkRoot = path.join(base, "link");
    fs.symlinkSync(root, linkRoot);

    const read = createReadTool(linkRoot);
    const ok = await read.execute("r1", { path: "src/a.ts" });
    expect(ok.details).toMatchObject({ totalLines: 1 });

    // …while escaping through the same root is still caught.
    const write = createWriteTool(linkRoot);
    await expect(write.execute("r2", { path: "out-dir/evil.txt", content: "x" }))
      .rejects.toThrow(/resolves outside project/i);

    fs.rmSync(base, { recursive: true, force: true });
  });
});
