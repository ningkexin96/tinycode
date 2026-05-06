import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickLatestSessionForCwd, resolveInteractiveSession } from "../src/cli/sessions.js";
import { SessionManager } from "../src/session/manager.js";
import { bootstrapHarness, type Harness } from "../src/bootstrap.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

/**
 * Regression tests for the default session lifecycle:
 *   tinycode            → live new session
 *   tinycode --continue → newest session for THIS cwd only
 *   tinycode --session  → that session
 *   /new                → fresh id + cleared context, harness intact
 *   /resume <id>        → live context replaced by target session
 */

let home: string;
let sessDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-session-lifecycle-"));
  process.env.TINYCODE_HOME = home;
  // Production storage lives at $TINYCODE_HOME/sessions.
  sessDir = path.join(home, "sessions");
});

describe("resolveInteractiveSession (CLI lifecycle)", () => {
  it("plain launch always starts a new session", () => {
    const option = resolveInteractiveSession({ continueLast: false, sessionId: undefined }, "/anywhere");
    expect(option).toEqual({ mode: "new" });
  });

  it("--continue picks the newest session for the same cwd", () => {
    const manager = new SessionManager(sessDir);
    const aOld = manager.start("/proj-a", "m");
    const b = manager.start("/proj-b", "m"); // most recent globally
    const aNew = manager.start("/proj-a", "m");

    // Deterministic mtimes: b newest overall, aNew newer than aOld.
    const t = (offset: number) => new Date(Date.now() + offset);
    fs.utimesSync(path.join(sessDir, `${aOld}.jsonl`), t(0), t(0));
    fs.utimesSync(path.join(sessDir, `${b}.jsonl`), t(2000), t(2000));
    fs.utimesSync(path.join(sessDir, `${aNew}.jsonl`), t(1000), t(1000));

    const picked = pickLatestSessionForCwd(manager, "/proj-a");
    expect(picked!.id).toBe(aNew);

    const option = resolveInteractiveSession({ continueLast: true, sessionId: undefined }, "/proj-a", () => {});
    expect(option.mode).toBe("attach");
    if (option.mode === "attach") expect(option.id).toBe(aNew);
    void aOld;
  });

  it("--continue never restores another project's session", () => {
    const manager = new SessionManager(sessDir);
    manager.start("/proj-a", "m");
    manager.start("/proj-b", "m"); // most recent globally

    const option = resolveInteractiveSession(
      { continueLast: true, sessionId: undefined },
      "/proj-a",
      () => {},
    );
    expect(option.mode).toBe("attach");
    if (option.mode === "attach") {
      expect(option.id).toBe(pickLatestSessionForCwd(manager, "/proj-a")!.id);
    }
  });

  it("--continue falls back to a new session when cwd has no history", () => {
    const manager = new SessionManager(sessDir);
    manager.start("/other-project", "m");
    const notes: string[] = [];
    const option = resolveInteractiveSession(
      { continueLast: true, sessionId: undefined },
      "/fresh-project",
      (line) => notes.push(line),
    );
    expect(option).toEqual({ mode: "new" });
    expect(notes[0]).toContain("no previous session");
  });

  it("--session attaches exactly the requested id", () => {
    const option = resolveInteractiveSession(
      { continueLast: false, sessionId: "abc123" },
      "/x",
    );
    expect(option).toEqual({ mode: "attach", id: "abc123" });
  });
});

describe("default interactive session lifecycle (harness level)", () => {
  async function bootInteractive(): Promise<Harness> {
    return bootstrapHarness({
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tc-life-proj-")),
      config: { permissionMode: "auto" },
      mock: true,
      // what plain `tinycode` now does
      session: resolveInteractiveSession({ continueLast: false, sessionId: undefined }, process.cwd()),
    });
  }

  it("default interactive harness creates an active session (Test 1)", async () => {
    const harness = await bootInteractive();
    try {
      expect(harness.session).toBeDefined();
      expect(harness.session!.id).toBeDefined();

      await harness.runtime.prompt("first message");
      const files = fs.readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const raw = fs.readFileSync(path.join(sessDir, files[0]!), "utf8");
      expect(raw).toContain("first message");

      // /sessions would show the current session on first run.
      const list = harness.session!.list();
      expect(list.map((s) => s.id)).toContain(harness.session!.id);
    } finally {
      await harness.shutdown();
    }
  }, 30000);

  it("/new creates a different session and later prompts write to the new file (Test 2)", async () => {
    const harness = await bootInteractive();
    try {
      const oldId = harness.session!.id!;
      await harness.runtime.prompt("belongs to old session");

      // What TuiApp.startNewSession + agent.reset do for /new:
      const newId = harness.session!.start(harness.projectRoot, "mock/tinycode-mock");
      harness.runtime.agent.reset();
      expect(newId).not.toBe(oldId);

      await harness.runtime.prompt("belongs to new session");

      const oldRaw = fs.readFileSync(path.join(sessDir, `${oldId}.jsonl`), "utf8");
      const newRaw = fs.readFileSync(path.join(sessDir, `${newId}.jsonl`), "utf8");
      expect(oldRaw).toContain("belongs to old session");
      expect(oldRaw).not.toContain("belongs to new session");
      expect(newRaw).toContain("belongs to new session");
      expect(newRaw).not.toContain("belongs to old session");
    } finally {
      await harness.shutdown();
    }
  }, 30000);

  it("/new keeps the harness intact — tool calling still works after reset", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-life-reset-"));
    fs.writeFileSync(path.join(workdir, "marker.txt"), "still here\n");
    const harness = await bootstrapHarness({
      projectRoot: workdir,
      config: { permissionMode: "auto" },
      mock: true,
      session: { mode: "new" },
    });
    try {
      const modelBefore = harness.runtime.agent.state.model;
      const toolsBefore = harness.tools.names().join(",");

      // /new
      harness.session!.start(workdir, "mock/tinycode-mock");
      harness.runtime.agent.reset();

      expect(harness.runtime.agent.state.model).toBe(modelBefore);
      expect(harness.tools.names().join(",")).toBe(toolsBefore);
      expect(harness.runtime.agent.state.systemPrompt.length).toBeGreaterThan(0);

      harness.models.mockHandle!.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "marker.txt" })]),
        fauxAssistantMessage("Read marker after /new."),
      ]);
      await harness.runtime.prompt("read the marker again");

      const results = harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
      expect(results).toHaveLength(1);
      expect(results[0]!.isError).toBe(false);
      expect(JSON.stringify(results[0]!.content)).toContain("still here");
    } finally {
      await harness.shutdown();
    }
  }, 30000);

  it("/resume replaces the live context with the target session (Test 3)", async () => {
    const harnessA = await bootstrapHarness({
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tc-life-a-")),
      config: { permissionMode: "auto" },
      mock: true,
      session: { mode: "new" },
    });
    harnessA.models.mockHandle!.setResponses([fauxAssistantMessage("answer A2")]);
    await harnessA.runtime.prompt("question A1");
    const idA = harnessA.session!.id!;

    const harnessB = await bootstrapHarness({
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tc-life-b-")),
      config: { permissionMode: "auto" },
      mock: true,
      session: { mode: "new" },
    });
    harnessB.models.mockHandle!.setResponses([fauxAssistantMessage("answer B2")]);
    await harnessB.runtime.prompt("question B1");
    const idB = harnessB.session!.id!;
    await harnessB.shutdown();
    await harnessA.shutdown();

    // Fresh interactive process resumes B then switches to A (/resume A).
    const resumed = await bootstrapHarness({
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tc-life-c-")),
      config: { permissionMode: "auto" },
      mock: true,
      session: { mode: "attach", id: idB },
    });
    try {
      expect(resumed.runtime.agent.state.messages.length).toBeGreaterThan(0);

      // /resume(idA): attach + replace live transcript.
      resumed.session!.attach(idA, resumed.projectRoot, "mock/tinycode-mock");
      const loadedA = resumed.session!.load(idA)!;
      const current = [...resumed.runtime.agent.state.messages];
      current.splice(0, current.length, ...loadedA.messages);
      resumed.runtime.agent.state.messages = current;

      const texts = JSON.stringify(resumed.runtime.agent.state.messages);
      expect(texts).toContain("question A1");
      expect(texts).not.toContain("question B1");

      // Subsequent messages append to the resumed session's file.
      const sizeBefore = fs.statSync(path.join(sessDir, `${idA}.jsonl`)).size;
      resumed.models.mockHandle!.setResponses([fauxAssistantMessage("answer A3")]);
      await resumed.runtime.prompt("follow-up on A");
      expect(fs.statSync(path.join(sessDir, `${idA}.jsonl`)).size).toBeGreaterThan(sizeBefore);
    } finally {
      await resumed.shutdown();
    }
  }, 60000);
});
