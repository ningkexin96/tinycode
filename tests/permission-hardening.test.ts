import { describe, expect, it, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { bootstrapHarness, type Harness } from "../src/bootstrap.js";
import { PermissionManager } from "../src/permissions/manager.js";
import { createProposeKnowledgeEditTool } from "../src/tools/knowledge.js";
import type { Ticket } from "../src/domain/types.js";

/**
 * Hardening regressions for non-interactive (headless `-p`) semantics:
 *
 *   headless, no dialog  → ASK verdicts DENY (reads still run)
 *   --permission-mode auto → explicit opt-in restores automation
 *
 * The knowledge base is the high-stakes surface: a denied propose_knowledge_edit
 * must leave the article byte-identical.
 */

const supportDesk = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/support-desk",
);

const OLD_LINE = "退款审核通过后，款项在 7 个工作日内退回原支付渠道。";
const NEW_LINE = "退款审核通过后，款项在 3 个工作日内退回原支付渠道。";

const harnesses: Harness[] = [];
afterAll(async () => {
  await Promise.all(harnesses.map((h) => h.shutdown()));
});

let workdir: string;

beforeEach(() => {
  // Private copy of the ticket desk so permission tests never dirty the repo.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tc-headless-"));
  fs.cpSync(supportDesk, path.join(base, "desk"), { recursive: true });
  workdir = path.join(base, "desk");
  process.env.TINYCODE_HOME = path.join(base, "home");
  // TINYCODE_PERMISSION_MODE must not leak an implicit auto into these tests.
  delete process.env.TINYCODE_PERMISSION_MODE;
});

/** What `tinycode -p` builds: no prompt callback exists at all. */
async function bootPrintLike(permissionMode: "ask" | "auto"): Promise<Harness> {
  const harness = await bootstrapHarness({
    projectRoot: workdir,
    config: {
      permissionMode,
      knowledgeDir: "knowledge",
      ticketsDir: "tickets",
      queues: ["售后组", "物流组", "技术支持"],
      maxStepsPerTurn: 12,
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

function resultText(result: { content: unknown }): string {
  return JSON.stringify(result.content);
}

function readTicket(id: string): Ticket {
  return JSON.parse(fs.readFileSync(path.join(workdir, "tickets", `${id}.json`), "utf8")) as Ticket;
}

function readRefundPolicy(): string {
  return fs.readFileSync(path.join(workdir, "knowledge", "refund-policy.md"), "utf8");
}

describe("headless (-p style) permission semantics", () => {
  it("read-only tools still execute without any dialog", async () => {
    const harness = await bootPrintLike("ask");
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tickets", { status: "open" })]),
      fauxAssistantMessage([fauxToolCall("search_knowledge", { query: "退款 时效" })]),
      fauxAssistantMessage("I inspected the queue and the refund policy."),
    ]);
    await harness.runtime.prompt("盘点待处理工单并查阅退款政策");

    const results = toolResults(harness);
    expect(results).toHaveLength(2);
    expect(results[0]!.isError).toBe(false);
    expect(resultText(results[0]!)).toContain("T-1001");
    expect(results[1]!.isError).toBe(false);
    expect(resultText(results[1]!)).toContain("refund-policy");
  });

  it("reply_customer is denied without any dialog and writes nothing", async () => {
    const harness = await bootPrintLike("ask");
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([
        fauxToolCall("reply_customer", {
          ticket_id: "T-1001",
          message: "您好，退款将在 3 个工作日内到账。",
        }),
      ]),
      fauxAssistantMessage("I could not answer the customer because permission was denied."),
    ]);
    await harness.runtime.prompt("回复客户 T-1001");

    const results = toolResults(harness);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(resultText(results[0]!)).toMatch(/Permission denied|no permission prompt/);

    const ticket = readTicket("T-1001");
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages.every((m) => m.from === "customer")).toBe(true);
    expect(JSON.stringify(ticket)).not.toContain("3 个工作日内到账");
  });

  it("propose_knowledge_edit is denied without any dialog and leaves the article untouched", async () => {
    const before = readRefundPolicy();
    const harness = await bootPrintLike("ask");
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([
        fauxToolCall("propose_knowledge_edit", {
          article_id: "refund-policy",
          old_text: OLD_LINE,
          new_text: NEW_LINE,
          rationale: "时效从 7 个工作日收紧到 3 个工作日",
        }),
      ]),
      fauxAssistantMessage("The knowledge-base edit needs a human reviewer."),
    ]);
    await harness.runtime.prompt("更新退款时效");

    const results = toolResults(harness);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(resultText(results[0]!)).toMatch(/Permission denied|no permission prompt/);

    expect(readRefundPolicy()).toBe(before);
    expect(readRefundPolicy()).toContain(OLD_LINE);
    expect(readRefundPolicy()).not.toContain(NEW_LINE);
  });

  it("the tool itself would write — the permission gate is what protects the article", async () => {
    const tool = createProposeKnowledgeEditTool({ projectRoot: workdir });
    const result = await tool.execute("t1", {
      article_id: "refund-policy",
      old_text: OLD_LINE,
      new_text: NEW_LINE,
      rationale: "un-gated call",
    });
    expect((result.details as { applied: boolean }).applied).toBe(true);
    expect(readRefundPolicy()).toContain(NEW_LINE);
  });

  it("explicit auto mode still approves ASK operations (opt-in preserved)", async () => {
    const harness = await bootPrintLike("auto");
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([
        fauxToolCall("reply_customer", {
          ticket_id: "T-1001",
          message: "您好，退款将在 3 个工作日内到账。",
        }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("propose_knowledge_edit", {
          article_id: "refund-policy",
          old_text: OLD_LINE,
          new_text: NEW_LINE,
          rationale: "时效调整为 3 个工作日",
        }),
      ]),
      fauxAssistantMessage("Answered the customer and updated the policy."),
    ]);
    await harness.runtime.prompt("回复客户并更新政策");

    const results = toolResults(harness);
    expect(results).toHaveLength(2);
    expect(results[0]!.isError).toBe(false);
    expect(results[1]!.isError).toBe(false);

    const ticket = readTicket("T-1001");
    expect(ticket.messages.some((m) => m.from === "agent")).toBe(true);
    expect(readRefundPolicy()).toContain(NEW_LINE);
  });

  it("a no-op knowledge edit needs no approval, even headlessly", async () => {
    const before = readRefundPolicy();
    const harness = await bootPrintLike("ask");
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([
        fauxToolCall("propose_knowledge_edit", {
          article_id: "refund-policy",
          old_text: OLD_LINE,
          new_text: OLD_LINE,
          rationale: "内容已经正确",
        }),
      ]),
      fauxAssistantMessage("Nothing to change — the policy is already current."),
    ]);
    await harness.runtime.prompt("确认退款时效是否需要修改");

    const results = toolResults(harness);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);
    expect(resultText(results[0]!)).toContain("短路");
    expect((results[0]!.details as { applied: boolean }).applied).toBe(false);
    expect(readRefundPolicy()).toBe(before);
  });
});

describe("PermissionManager ASK semantics (unit level)", () => {
  it("denies ASK tools headlessly while allowing reads, triage and no-op edits", async () => {
    const manager = new PermissionManager({ mode: "ask", projectRoot: workdir });

    expect((await manager.check("list_tickets", {})).action).toBe("allow");
    expect((await manager.check("get_ticket", { ticket_id: "T-1001" })).action).toBe("allow");
    expect((await manager.check("classify_ticket", { ticket_id: "T-1001" })).action).toBe("allow");
    expect((await manager.check("route_ticket", { ticket_id: "T-1001", queue: "售后组" })).action).toBe("allow");
    expect((await manager.check("escalate_ticket", { ticket_id: "T-1001", level: 1 })).action).toBe("allow");

    for (const [toolName, input] of [
      ["reply_customer", { ticket_id: "T-1001", message: "hi" }],
      ["escalate_ticket", { ticket_id: "T-1001", level: 2 }],
      ["propose_knowledge_edit", { article_id: "refund-policy", old_text: OLD_LINE, new_text: NEW_LINE }],
    ] as const) {
      const decision = await manager.check(toolName, input);
      expect(decision.action, toolName).toBe("deny");
      expect(decision.reason).toContain("no permission prompt available");
    }

    const noop = await manager.check("propose_knowledge_edit", {
      article_id: "refund-policy",
      old_text: OLD_LINE,
      new_text: OLD_LINE,
    });
    expect(noop.action).toBe("allow");
  });

  it("auto mode approves the very same ASK calls", async () => {
    const manager = new PermissionManager({ mode: "auto", projectRoot: workdir });
    for (const [toolName, input] of [
      ["reply_customer", { ticket_id: "T-1001", message: "hi" }],
      ["escalate_ticket", { ticket_id: "T-1001", level: 2 }],
      ["propose_knowledge_edit", { article_id: "refund-policy", old_text: OLD_LINE, new_text: NEW_LINE }],
    ] as const) {
      const decision = await manager.check(toolName, input);
      expect(decision.action, toolName).toBe("allow");
      expect(decision.reason).toContain("auto-approved");
    }
  });
});
