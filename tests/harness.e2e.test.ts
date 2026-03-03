import { describe, expect, it, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { bootstrapHarness, type Harness } from "../src/bootstrap.js";

/**
 * End-to-end harness test — the heart of the suite.
 *
 * A fixture project contains a deliberately broken add() (returns a - b).
 * The scripted mock model drives the REAL agent loop through:
 *   bash (run failing test) → read → edit → bash (run passing test) → final
 *
 * This exercises Pi Agent Runtime + TinyCode tools + permissions + context +
 * session persistence as one integrated system.
 */

let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-e2e-"));
  // Copy the broken fixture into a scratch dir so tests never mutate the repo.
  fs.copyFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/broken-project/add.js"),
    path.join(workdir, "add.js"),
  );
  fs.writeFileSync(
    path.join(workdir, "add.test.js"),
    [
      "import assert from 'node:assert';",
      "import { add } from './add.js';",
      "assert.equal(add(1,2),3);",
      "console.log('all tests passed');",
    ].join("\n"),
  );
  process.env.TINYCODE_HOME = path.join(workdir, ".tinycode-home");
});

const harnesses: Harness[] = [];
afterAll(async () => {
  await Promise.all(harnesses.map((h) => h.shutdown()));
});

function script(): AssistantMessage[] {
  return [
    fauxAssistantMessage([fauxToolCall("bash", { command: "node add.test.js" })]),
    fauxAssistantMessage([fauxToolCall("read", { path: "add.js" })]),
    fauxAssistantMessage([
      fauxToolCall("edit", { path: "add.js", oldText: "return a - b;", newText: "return a + b;" }),
    ]),
    fauxAssistantMessage([fauxToolCall("bash", { command: "node add.test.js" })]),
    fauxAssistantMessage("Fixed! add() now returns a + b and all tests pass."),
  ];
}

describe("agent harness E2E (mock model → real tools)", () => {
  it("runs read → edit → bash → final and leaves the fixture fixed", async () => {
    const harness = await bootstrapHarness({
      projectRoot: workdir,
      config: { permissionMode: "auto" },
      mock: true,
      session: { mode: "new" },
    });
    harnesses.push(harness);
    harness.models.mockHandle!.setResponses(script());

    await harness.runtime.prompt("Fix the failing test in this project.");

    const messages = harness.runtime.agent.state.messages;
    const toolCalls = messages.flatMap((m) =>
      m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall") : [],
    );
    expect(toolCalls.map((c) => c.name)).toEqual(["bash", "read", "edit", "bash"]);

    const results = messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(4);

    // First bash run failed (nonzero exit surfaced in content); second passed.
    const firstRun = results[0]!;
    expect(firstRun.isError).toBe(false);
    const firstOutput = firstRun.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(firstOutput).toContain("✗ exit 1");
    expect(firstOutput).toContain("AssertionError");

    const secondRun = results[3]!;
    expect(secondRun.isError).toBe(false);
    expect(secondRun.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("all tests passed");

    // Edit reported a real diff.
    const editResult = results[2]!;
    expect(JSON.stringify(editResult.details)).toContain('"additions":1');

    // Fixture is actually fixed on disk.
    expect(fs.readFileSync(path.join(workdir, "add.js"), "utf8")).toContain("return a + b;");
    expect(fs.readFileSync(path.join(workdir, "add.js"), "utf8")).not.toContain("a - b");

    // Session persisted the full transcript.
    expect(harness.session).toBeDefined();
    const sessionId = harness.session!.id!;
    const loaded = harness.session!.load(sessionId)!;
    expect(loaded.messages.length).toBe(messages.length);
  }, 60000);

  it("blocks dangerous commands when permission is denied by policy", async () => {
    const harness = await bootstrapHarness({
      projectRoot: workdir,
      config: {
        permissionMode: "ask",
        // No prompt callback wired in headless mode: asks deny safely.
      },
      mock: true,
    });
    harnesses.push(harness);
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ./everything" })]),
      fauxAssistantMessage("I could not delete files because permission was denied."),
    ]);

    await harness.runtime.prompt("delete everything");

    const results = harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(JSON.stringify(results[0]!.content)).toMatch(/Permission denied/);
  }, 30000);

  it("auto mode allows the same dangerous command (test/CI behavior)", async () => {
    const harness = await bootstrapHarness({
      projectRoot: workdir,
      config: { permissionMode: "auto" },
      mock: true,
    });
    harnesses.push(harness);
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "add.js" })]),
      fauxAssistantMessage("done reading"),
    ]);
    await harness.runtime.prompt("read the file");
    const results = harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
    expect(results[0]!.isError).toBe(false);
  }, 30000);

  it("resumes a saved session with full history in a fresh harness", async () => {
    const first = await bootstrapHarness({
      projectRoot: workdir,
      config: { permissionMode: "auto" },
      mock: true,
      session: { mode: "new" },
    });
    harnesses.push(first);
    first.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "note.txt", content: "remember me" })]),
      fauxAssistantMessage("Stored a note."),
    ]);
    await first.runtime.prompt("store a note");
    const sessionId = first.session!.id!;
    const countAfterFirst = first.runtime.agent.state.messages.length;
    await first.shutdown();

    const second = await bootstrapHarness({
      projectRoot: workdir,
      config: { permissionMode: "auto" },
      mock: true,
      session: { mode: "attach", id: sessionId },
    });
    harnesses.push(second);
    second.models.mockHandle!.setResponses([fauxAssistantMessage("The note says: remember me")]);
    await second.runtime.prompt("what does the note say?");

    expect(second.runtime.agent.state.messages.length).toBeGreaterThan(countAfterFirst);
    const userTexts = second.runtime.agent.state.messages
      .filter((m) => "role" in m && m.role === "user")
      .map((m) => JSON.stringify("content" in m ? m.content : ""));
    expect(userTexts.some((text) => text.includes("what does the note say?"))).toBe(true);

    // The resumed transcript still contains the original write.
    expect(
      JSON.stringify(second.runtime.agent.state.messages),
    ).toContain("remember me");
  }, 60000);
});
