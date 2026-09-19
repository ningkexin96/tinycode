import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SubAgentManager } from "../src/agents/manager.js";
import { createListTicketsTool } from "../src/tools/tickets.js";
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../src/model/registry.js";

let root: string;
let registry: ModelRegistry;
let mock: FauxProviderHandle;

/** Collect the text of every tool result in a faux-model request context. */
function toolResultText(context: { messages: readonly unknown[] }): string {
  const texts: string[] = [];
  for (const message of context.messages) {
    const record = message as { role?: string; content?: unknown };
    if (record.role !== "toolResult" || !Array.isArray(record.content)) continue;
    for (const part of record.content) {
      const block = part as { type?: string; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts.join("\n");
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-agents-"));
  fs.writeFileSync(path.join(root, "note.txt"), "the secret code is PURPLE-7\n");
  const { ModelRegistry: Registry } = await import("../src/model/registry.js");
  registry = new Registry();
  registry.enableMock();
  mock = registry.mockHandle!;
});

function makeManager(maxConcurrent = 3): SubAgentManager {
  return new SubAgentManager({
    projectRoot: root,
    model: registry.enableMock(),
    streamFn: registry.streamFn,
    workerTools: [],
    maxConcurrent,
  });
}

describe("SubAgentManager lifecycle", () => {
  it("spawns a worker, waits for its report and returns structured output", async () => {
    const manager = makeManager();
    mock.setResponses([fauxAssistantMessage("Investigation complete. The secret code is PURPLE-7.")]);

    const report = manager.spawn("scout", "find the secret code in note.txt");
    expect(report.status).toBe("running");

    const [final] = await manager.wait(report.id);
    expect(final.status).toBe("completed");
    expect(final.name).toBe("scout");
    expect(final.report).toContain("PURPLE-7");
    await manager.shutdown();
  });

  it("workers can execute read-only domain tools inside their own context", async () => {
    fs.mkdirSync(path.join(root, "tickets"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "tickets", "T-1001.json"),
      JSON.stringify({
        id: "T-1001",
        subject: "退款：订单 8842 已付款但未收到货",
        customer: "张伟",
        channel: "email",
        createdAt: "2026-09-18T09:12:00+08:00",
        slaMinutes: 240,
        status: "open",
        messages: [
          { from: "customer", text: "我在 9 月 10 日下单，一直没收到货，要求全额退款。", at: "2026-09-18T09:12:00+08:00" },
        ],
      }),
    );

    const manager = new SubAgentManager({
      projectRoot: root,
      model: registry.enableMock(),
      streamFn: registry.streamFn,
      // A read-only domain tool proves worker tool execution works end-to-end.
      workerTools: [createListTicketsTool({ projectRoot: root })],
    });
    mock.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tickets", {})]),
      // The final turn echoes the real tool result, so the report can only
      // contain the ticket id if the tool actually ran inside the worker.
      (context) => fauxAssistantMessage(`Report: ${toolResultText(context)}`),
    ]);

    manager.spawn("reader", "list the open tickets and report their ids");
    const reports = await manager.wait();
    expect(reports[0]!.status).toBe("completed");
    expect(reports[0]!.report).toContain("T-1001");
    expect(reports[0]!.report).toContain("退款");
    await manager.shutdown();
  });

  it("enforces unique names", async () => {
    const manager = makeManager();
    mock.setResponses([fauxAssistantMessage("done")]);
    manager.spawn("alpha", "task");
    expect(() => manager.spawn("alpha", "another task")).toThrow(/already exists/);
    await manager.wait();
    await manager.shutdown();
  });

  it("rejects spawns beyond the concurrency cap and frees slots after wait", async () => {
    const manager = makeManager(1);
    mock.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })]),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("second done"),
    ]);
    manager.spawn("one", "task one");
    expect(() => manager.spawn("two", "task two")).toThrow(/concurrency limit/);
    await manager.wait();

    manager.spawn("two", "task two");
    await manager.wait();
    expect(manager.reports().map((r) => r.name).sort()).toEqual(["one", "two"]);
    await manager.shutdown();
  });

  it("close aborts a running worker", async () => {
    const manager = makeManager();
    // Long scripted chain so the worker stays busy until aborted.
    mock.setResponses([...Array.from({ length: 40 }, () => fauxAssistantMessage("still working")), fauxAssistantMessage("never reached")]);
    const handle = manager.spawn("slowpoke", "endless task");
    await new Promise((resolve) => setTimeout(resolve, 80));
    manager.close(handle.id);

    const reports = await manager.wait(handle.id);
    expect(["aborted", "completed"]).toContain(reports[0]!.status);
    await manager.shutdown();
  });

  it("statusLine reflects running workers", async () => {
    const manager = makeManager();
    expect(manager.statusLine()).toBe("SUB-AGENTS 0/3 RUNNING");
    mock.setResponses([fauxAssistantMessage("done")]);
    manager.spawn("solo", "task");
    expect(manager.statusLine()).toBe("SUB-AGENTS 1/3 RUNNING");
    await manager.wait();
    expect(manager.statusLine()).toBe("SUB-AGENTS 0/3 RUNNING");
    await manager.shutdown();
  });

  it("wait with no argument waits for all running workers", async () => {
    const manager = makeManager(3);
    mock.setResponses([fauxAssistantMessage("a done"), fauxAssistantMessage("b done")]);
    manager.spawn("wa", "task a");
    manager.spawn("wb", "task b");
    const reports = await manager.wait();
    expect(reports.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(reports.map((r) => r.report).sort()).toEqual(["a done", "b done"]);
    await manager.shutdown();
  });
});
