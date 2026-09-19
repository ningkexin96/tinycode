import { describe, expect, it, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { bootstrapHarness, type Harness } from "../src/bootstrap.js";

/**
 * Unit tests for TinyCodeRuntime.runAgentTurn — the per-turn guard that keeps
 * long ticket sessions predictable:
 *
 *   normal reply       → "completed"
 *   thinking-only turn → "empty-response" (+ note)
 *   runaway tool loop  → "max-steps" (bounded, transcript still consistent)
 *
 * Everything runs on the offline faux provider wired by ModelRegistry.enableMock.
 */

const harnesses: Harness[] = [];
afterAll(async () => {
  await Promise.all(harnesses.map((h) => h.shutdown()));
});

let workdir: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tc-agent-turn-"));
  workdir = path.join(base, "desk");
  fs.mkdirSync(path.join(workdir, "tickets"), { recursive: true });
  fs.writeFileSync(
    path.join(workdir, "tickets", "T-1001.json"),
    JSON.stringify({
      id: "T-1001",
      subject: "退款：订单 8842 已付款但未收到货",
      customer: "张伟",
      channel: "email",
      createdAt: "2026-09-18T09:12:00+08:00",
      slaMinutes: 240,
      status: "open",
      messages: [
        { from: "customer", text: "我在 9 月 10 日下单（订单号 8842），要求全额退款。", at: "2026-09-18T09:12:00+08:00" },
      ],
    }),
  );
  process.env.TINYCODE_HOME = path.join(base, "home");
  delete process.env.TINYCODE_PERMISSION_MODE;
  delete process.env.TINYCODE_MODEL;
});

async function boot(maxStepsPerTurn?: number): Promise<Harness> {
  const harness = await bootstrapHarness({
    projectRoot: workdir,
    config: {
      permissionMode: "auto",
      ticketsDir: "tickets",
      ...(maxStepsPerTurn !== undefined ? { maxStepsPerTurn } : {}),
    },
    mock: true,
    session: { mode: "new" },
  });
  harnesses.push(harness);
  return harness;
}

function toolResults(harness: Harness) {
  return harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
}

/** A script long enough that only the step guard can stop the loop. */
function endlessToolLoop(step: number): ReturnType<typeof fauxAssistantMessage>[] {
  return Array.from({ length: step }, () => fauxAssistantMessage([fauxToolCall("list_tickets", {})]));
}

describe("runAgentTurn — completed", () => {
  it("returns the assistant text with step accounting", async () => {
    const harness = await boot();
    harness.models.mockHandle!.setResponses([fauxAssistantMessage("T-1001 已分流到售后组。")]);

    const result = await harness.runtime.runAgentTurn("处理 T-1001");

    expect(result.status).toBe("completed");
    expect(result.text).toBe("T-1001 已分流到售后组。");
    expect(result.steps).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.note).toBeUndefined();
  });

  it("counts tool calls and keeps the transcript usable for the next turn", async () => {
    const harness = await boot();
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("get_ticket", { ticket_id: "T-1001" })]),
      fauxAssistantMessage("T-1001 属于退款类，建议路由到售后组。"),
    ]);

    const result = await harness.runtime.runAgentTurn("读取 T-1001 并给出处理建议");
    expect(result.status).toBe("completed");
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.text).toContain("售后组");
    expect(toolResults(harness)).toHaveLength(1);

    // A second turn on the same runtime starts with a clean guard.
    harness.models.mockHandle!.setResponses([fauxAssistantMessage("刚才那条是 T-1001。")]);
    const second = await harness.runtime.runAgentTurn("刚才那条工单号是多少？");
    expect(second.status).toBe("completed");
    expect(second.steps).toBe(1);
    expect(second.toolCalls).toBe(0);
  });
});

describe("runAgentTurn — empty-response fallback", () => {
  it("reports a note when the model returns no text (thinking only)", async () => {
    const harness = await boot();
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxThinking("先看看工单，再决定分类……")]),
    ]);

    const result = await harness.runtime.runAgentTurn("处理工单");

    expect(result.status).toBe("empty-response");
    expect(result.text).toBe("");
    expect(result.note).toBeDefined();
    expect(result.note).toContain("空响应");
  });

  it("reports a note for a genuinely empty assistant message", async () => {
    const harness = await boot();
    harness.models.mockHandle!.setResponses([fauxAssistantMessage("")]);

    const result = await harness.runtime.runAgentTurn("处理工单");

    expect(result.status).toBe("empty-response");
    expect(result.text).toBe("");
    expect(result.note).toContain("空响应");
  });
});

describe("runAgentTurn — max-steps guard", () => {
  it("stops a runaway tool loop at the requested maxSteps", async () => {
    const harness = await boot();
    harness.models.mockHandle!.setResponses([
      ...endlessToolLoop(20),
      fauxAssistantMessage("这条永远不该被执行。"),
    ]);

    const result = await harness.runtime.runAgentTurn("一直查工单", { maxSteps: 2 });

    expect(result.status).toBe("max-steps");
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.note).toContain("最大步数");
    // The loop really was cut short: scripted responses are still queued.
    expect(toolResults(harness)).toHaveLength(2);
    expect(harness.models.mockHandle!.getPendingResponseCount()).toBeGreaterThan(0);
  });

  it("honours config.maxStepsPerTurn when no per-call budget is given", async () => {
    const harness = await boot(3);
    harness.models.mockHandle!.setResponses(endlessToolLoop(12));

    const result = await harness.runtime.runAgentTurn("一直查工单");

    expect(result.status).toBe("max-steps");
    expect(result.steps).toBe(3);
    expect(result.toolCalls).toBe(3);
    expect(result.note).toContain("3");
  });

  it("does not carry the limit into the following turn", async () => {
    const harness = await boot();
    harness.models.mockHandle!.setResponses(endlessToolLoop(20));
    const stopped = await harness.runtime.runAgentTurn("一直查工单", { maxSteps: 1 });
    expect(stopped.status).toBe("max-steps");

    harness.models.mockHandle!.setResponses([fauxAssistantMessage("本轮已收敛：T-1001 → 售后组。")]);
    const after = await harness.runtime.runAgentTurn("总结一下");

    expect(after.status).toBe("completed");
    expect(after.note).toBeUndefined();
    expect(after.steps).toBe(1);
    expect(after.text).toContain("售后组");
  });

  it("a plain prompt() (TUI path) is not subject to the turn guard", async () => {
    const harness = await boot(1);
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tickets", {})]),
      fauxAssistantMessage([fauxToolCall("list_tickets", {})]),
      fauxAssistantMessage("两条查询都完成了。"),
    ]);

    await harness.runtime.prompt("列出所有工单");

    expect(toolResults(harness)).toHaveLength(2);
    expect(JSON.stringify(harness.runtime.agent.state.messages)).toContain("两条查询都完成了。");
  });
});
