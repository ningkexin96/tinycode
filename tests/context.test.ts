import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import { ContextManager } from "../src/context/manager.js";
import { truncateMiddle, saveArtifact } from "../src/context/tool-results.js";
import { splitForCompact, estimateTokens, buildTranscriptText } from "../src/context/compact.js";

function userMessage(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "mock",
    provider: "mock",
    model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function toolResultMessage(text: string) {
  return {
    role: "toolResult" as const,
    toolCallId: "tc1",
    toolName: "bash",
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("tool-result truncation", () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-artifacts-"));
  });

  it("keeps short text untouched", () => {
    expect(truncateMiddle("short", 100)).toEqual({ text: "short", droppedChars: 0 });
  });

  it("keeps head and tail with an explicit marker", () => {
    const long = "A".repeat(600) + "MIDDLE" + "B".repeat(600);
    const result = truncateMiddle(long, 400);
    expect(result.droppedChars).toBeGreaterThan(0);
    expect(result.text).toContain("[… ");
    expect(result.text).toContain("characters truncated …]");
    expect(result.text.startsWith("AAAA")).toBe(true);
    expect(result.text.endsWith("BBBB")).toBe(true);
    expect(result.text).not.toContain("MIDDLE");
  });

  it("saves full outputs as artifacts", () => {
    const file = saveArtifact(artifactsDir, "npm install", "x".repeat(50));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toHaveLength(50);
  });
});

describe("ContextManager afterToolCall hook", () => {
  function makeContext(outputText: string): AfterToolCallContext {
    return {
      assistantMessage: assistantMessage("go"),
      toolCall: { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
      args: {},
      result: { content: [{ type: "text", text: outputText }], details: { exitCode: 0 } },
      isError: false,
      context: { systemPrompt: "", messages: [] },
    };
  }

  it("passes small results through unchanged", () => {
    const manager = new ContextManager({ maxToolResultChars: 1000, compactAboveTokens: 0, keepRecentMessages: 10 });
    expect(manager.handleAfterToolCall(makeContext("tiny"))).toBeUndefined();
  });

  it("overrides oversized results and preserves details", () => {
    const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-artifacts-"));
    const manager = new ContextManager({
      maxToolResultChars: 500,
      compactAboveTokens: 0,
      keepRecentMessages: 10,
      artifactsDir,
    });
    const override = manager.handleAfterToolCall(makeContext("y".repeat(5000)));
    expect(override).toBeDefined();
    const textPart = override!.content![0] as { type: string; text: string };
    expect(textPart.text.length).toBeLessThan(1200);
    expect(textPart.text).toContain("[full output saved to");
    expect(override!.details).toEqual({ exitCode: 0 });
  });
});

const conversation = [
  userMessage("first task"),
  assistantMessage("working"),
  toolResultMessage("result one"),
  userMessage("second task"),
  assistantMessage("still working"),
];

describe("compaction helpers", () => {

  it("cuts only on user-message boundaries", () => {
    const long = [
      ...conversation,
      userMessage("third task"),
      assistantMessage("on it"),
      toolResultMessage("result two"),
      userMessage("final task"),
      assistantMessage("finishing"),
    ]; // users at index 0 and 5
    const split = splitForCompact(long, 3);
    // Latest valid user boundary ≤ len-keepRecent wins.
    expect(split.cutIndex).toBe(5);
    expect(long[split.cutIndex]!.role).toBe("user");
    expect(split.recent).toHaveLength(5);
    expect(split.old).toHaveLength(5);

  });

  it("refuses to compact when everything is protected", () => {
    const split = splitForCompact(conversation, conversation.length);
    expect(split.old).toHaveLength(0);
    expect(split.recent).toBe(conversation);
    // No internal user boundary within reach → nothing can be cut.
    const headless = [conversation[1]!, conversation[2]!];
    const single = splitForCompact(headless, 2);
    expect(single.old).toHaveLength(0);
  });

  it("renders a readable transcript", () => {
    const transcript = buildTranscriptText([conversation[0]!, conversation[1]!, conversation[2]!]);
    expect(transcript).toContain("[USER]");
    expect(transcript).toContain("[ASSISTANT]");
    expect(transcript).toContain("[TOOL RESULT for bash]");
  });

  it("estimates tokens deterministically", () => {
    const single = estimateTokens([userMessage("abcd")]);
    expect(single).toBeGreaterThan(0);
    expect(estimateTokens([userMessage("abcd"), userMessage("abcd")])).toBeGreaterThan(single);
  });
});

describe("ContextManager.compact", () => {
  it("replaces old turns with a summary message", async () => {
    const manager = new ContextManager({
      maxToolResultChars: 1000,
      compactAboveTokens: 0,
      keepRecentMessages: 3,
    });
    let summarizeCalls = 0;
    const summarize = async (transcript: string) => {
      summarizeCalls += 1;
      return `SUMMARY OF ${transcript.length} chars`;
    };
    const long = [
      ...conversation,
      userMessage("third task"),
      assistantMessage("on it"),
      toolResultMessage("result two"),
      userMessage("final task"),
      assistantMessage("finishing"),
    ];
    const compacted = await manager.compact(long, summarize);
    expect(summarizeCalls).toBe(1);
    expect(compacted[0]!.role).toBe("user");
    expect(JSON.stringify(compacted[0])).toContain("<conversation-summary>");
    expect(compacted).toHaveLength(1 + 5); // summary + recent from cut index 5
  });

  it("auto-compacts only above the token threshold via transformContext", async () => {
    const hot = new ContextManager({
      maxToolResultChars: 1000,
      compactAboveTokens: 10,
      keepRecentMessages: 2,
    });
    const long = [
      userMessage("task one"),
      assistantMessage("reply one"),
      toolResultMessage("result one"),
      userMessage("task two"),
      assistantMessage("reply two"),
      toolResultMessage("result two"),
      userMessage("task three"),
      assistantMessage("reply three"),
    ];
    const transformed = await hot.makeTransformContext(async () => "summary")(long);
    expect(transformed[0]!.role).toBe("user");
    expect(transformed.length).toBeLessThan(long.length);

    const quietManager = new ContextManager({
      maxToolResultChars: 1000,
      compactAboveTokens: 0,
      keepRecentMessages: 2,
    });
    const passthrough = await quietManager.makeTransformContext(async () => "should not run")(long);
    expect(passthrough).toBe(long);
  });
});
