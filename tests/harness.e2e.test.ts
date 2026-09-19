import { describe, expect, it, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { bootstrapHarness, type Harness } from "../src/bootstrap.js";
import type { Ticket } from "../src/domain/types.js";

/**
 * End-to-end harness test — the flagship ticket scenario.
 *
 * A scratch copy of fixtures/support-desk is driven by the scripted mock model
 * through the REAL agent loop + domain tools + permission gate + session
 * persistence:
 *
 *   list_tickets → get_ticket T-1001 → search_knowledge → classify_ticket
 *     → propose_knowledge_edit(refund-policy) → route_ticket → final message
 *
 * Ticket JSON and the knowledge article are asserted on disk afterwards; the
 * repo fixture itself must stay untouched.
 */

const supportDesk = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/support-desk",
);

const REFUND_OLD = "退款审核通过后，款项在 7 个工作日内退回原支付渠道。";
const REFUND_NEW = "退款审核通过后，款项在 3 个工作日内退回原支付渠道。";
const FINAL_TEXT =
  "已完成 T-1001 分流：分类 退款 · 优先级 P1 · 队列 售后组，并已提交退款时效修订（7 → 3 个工作日）。";

const harnesses: Harness[] = [];
afterAll(async () => {
  await Promise.all(harnesses.map((h) => h.shutdown()));
});

let workdir: string;
let home: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tc-e2e-support-"));
  fs.cpSync(supportDesk, path.join(base, "desk"), { recursive: true });
  workdir = path.join(base, "desk");
  home = path.join(base, "home");
  process.env.TINYCODE_HOME = home;
  delete process.env.TINYCODE_PERMISSION_MODE;
});

async function boot(options: { permissionMode: "ask" | "auto" }): Promise<Harness> {
  const harness = await bootstrapHarness({
    projectRoot: workdir,
    config: {
      permissionMode: options.permissionMode,
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

function readTicket(id: string): Ticket {
  return JSON.parse(fs.readFileSync(path.join(workdir, "tickets", `${id}.json`), "utf8")) as Ticket;
}

function readArticle(id: string): string {
  return fs.readFileSync(path.join(workdir, "knowledge", `${id}.md`), "utf8");
}

function toolResultMessages(harness: Harness) {
  return harness.runtime.agent.state.messages.filter((m) => m.role === "toolResult");
}

function toolCallNames(harness: Harness): string[] {
  return harness.runtime.agent.state.messages.flatMap((m) =>
    m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => c.name) : [],
  );
}

describe("agent harness E2E — ticket triage against fixtures/support-desk", () => {
  it("triages T-1001 through the real loop and lands every write on disk", async () => {
    const harness = await boot({ permissionMode: "auto" });
    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tickets", { status: "open" })]),
      fauxAssistantMessage([fauxToolCall("get_ticket", { ticket_id: "T-1001" })]),
      fauxAssistantMessage([fauxToolCall("search_knowledge", { query: "退款 时效" })]),
      fauxAssistantMessage([
        fauxToolCall("classify_ticket", {
          ticket_id: "T-1001",
          category: "退款",
          priority: "P1",
          intent: "订单 8842 已付款未收到货，要求全额退款",
          summary: "已核对物流轨迹停滞，按退款政策走全额退款。",
        }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("propose_knowledge_edit", {
          article_id: "refund-policy",
          old_text: REFUND_OLD,
          new_text: REFUND_NEW,
          rationale: "退款时效与当前履约能力对齐，7 个工作日收紧为 3 个工作日",
        }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("route_ticket", {
          ticket_id: "T-1001",
          queue: "售后组",
          reason: "依据 refund-policy：已付款未收到货，售后组执行全额退款",
        }),
      ]),
      fauxAssistantMessage(FINAL_TEXT),
    ]);

    const turn = await harness.runtime.runAgentTurn("请处理工单 T-1001：判定分类与优先级、必要时更新知识库并分流。", {
      maxSteps: 12,
    });

    // The run completed inside the step budget and executed every scripted call.
    expect(turn.status).toBe("completed");
    expect(turn.text).toBe(FINAL_TEXT);
    expect(turn.note).toBeUndefined();
    expect(turn.toolCalls).toBe(6);
    expect(turn.steps).toBe(7);

    expect(toolCallNames(harness)).toEqual([
      "list_tickets",
      "get_ticket",
      "search_knowledge",
      "classify_ticket",
      "propose_knowledge_edit",
      "route_ticket",
    ]);

    const results = toolResultMessages(harness);
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.isError === false)).toBe(true);

    // list_tickets saw the three fixture tickets.
    expect((results[0]!.details as { count: number }).count).toBe(3);
    expect(JSON.stringify(results[0]!.details)).toContain("T-1003");

    // get_ticket returned the full conversation of T-1001.
    expect(JSON.stringify(results[1]!.content)).toContain("订单号 8842");

    // search_knowledge ranked the refund policy first.
    const knowledge = results[2]!.details as { articles: { id: string }[] };
    expect(knowledge.articles[0]!.id).toBe("refund-policy");

    // classify_ticket persisted category/priority/status.
    expect(results[3]!.details).toMatchObject({
      ticket_id: "T-1001",
      category: "退款",
      priority: "P1",
      status: "triaged",
    });

    // propose_knowledge_edit produced a real one-line diff.
    const edit = results[4]!.details as { applied: boolean; additions: number; deletions: number; diff: string };
    expect(edit.applied).toBe(true);
    expect(edit.additions).toBe(1);
    expect(edit.deletions).toBe(1);
    expect(edit.diff).toContain("3 个工作日");

    // route_ticket moved the ticket to 售后组.
    expect(results[5]!.details).toMatchObject({ ticket_id: "T-1001", queue: "售后组", status: "routed" });

    // --- Disk state -------------------------------------------------------
    const ticket = readTicket("T-1001");
    expect(ticket.status).toBe("routed");
    expect(ticket.queue).toBe("售后组");
    expect(ticket.priority).toBe("P1");
    expect(ticket.category).toBe("退款");
    expect(ticket.intent).toContain("8842");
    expect(ticket.notes ?? []).toHaveLength(2);
    expect(JSON.stringify(ticket.notes)).toContain("refund-policy");

    const article = readArticle("refund-policy");
    expect(article).toContain(REFUND_NEW);
    expect(article).not.toContain(REFUND_OLD);

    // Other tickets were left alone.
    expect(readTicket("T-1002").status).toBe("open");
    expect(readTicket("T-1003").status).toBe("open");

    // --- Session persistence ---------------------------------------------
    expect(harness.session).toBeDefined();
    const sessionId = harness.session!.id!;
    const sessionFile = path.join(home, "sessions", `${sessionId}.jsonl`);
    expect(fs.existsSync(sessionFile)).toBe(true);
    const raw = fs.readFileSync(sessionFile, "utf8");
    expect(raw).toContain("T-1001");
    expect(raw).toContain("售后组");
    expect(raw).toContain("已完成 T-1001 分流");

    const loaded = harness.session!.load(sessionId)!;
    expect(loaded.messages.length).toBe(harness.runtime.agent.state.messages.length);
    expect(JSON.stringify(loaded.messages)).toContain("propose_knowledge_edit");
  }, 60000);

  it("asks a human before escalating to L2 and honours the approval", async () => {
    const harness = await boot({ permissionMode: "ask" });
    const requests: { toolName: string; reason: string }[] = [];
    harness.permissions.setPrompt(async (request) => {
      requests.push({ toolName: request.toolName, reason: request.reason });
      return "once";
    });

    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("get_ticket", { ticket_id: "T-1003" })]),
      fauxAssistantMessage([fauxToolCall("search_knowledge", { query: "升级 金额 权限" })]),
      fauxAssistantMessage([
        fauxToolCall("classify_ticket", {
          ticket_id: "T-1003",
          category: "账户",
          priority: "P0",
          intent: "企业客户账户被风控冻结，影响当日结算",
        }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("escalate_ticket", {
          ticket_id: "T-1003",
          level: 2,
          reason: "企业客户 + 风控冻结，依据 escalation-policy 升级主管",
        }),
      ]),
      fauxAssistantMessage("T-1003 已升级至 L2（主管），等待人工复核。"),
    ]);

    const turn = await harness.runtime.runAgentTurn("处理 T-1003 并判断是否需要升级。");
    expect(turn.status).toBe("completed");

    // classify/get/search are allow-level; only the L2 escalation prompted.
    expect(requests.map((r) => r.toolName)).toEqual(["escalate_ticket"]);
    expect(requests[0]!.reason).toContain("L2");

    const escalated = readTicket("T-1003");
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalateLevel).toBe(2);
    expect(JSON.stringify(escalated.notes)).toContain("escalation-policy");
  }, 60000);

  it("routes a logistics ticket without ever prompting (allow-level path)", async () => {
    const harness = await boot({ permissionMode: "ask" });
    let prompts = 0;
    harness.permissions.setPrompt(async () => {
      prompts += 1;
      return "deny";
    });

    harness.models.mockHandle!.setResponses([
      fauxAssistantMessage([fauxToolCall("get_ticket", { ticket_id: "T-1002" })]),
      fauxAssistantMessage([fauxToolCall("search_knowledge", { query: "物流 SLA 停滞" })]),
      fauxAssistantMessage([
        fauxToolCall("classify_ticket", {
          ticket_id: "T-1002",
          category: "物流",
          priority: "P2",
          intent: "包裹停滞 3 天未更新，客户询问到货时间",
        }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("route_ticket", {
          ticket_id: "T-1002",
          queue: "物流组",
          reason: "依据 logistics-sla：停滞超过 48 小时，物流组跟进",
        }),
      ]),
      fauxAssistantMessage("T-1002 已分流至物流组。"),
    ]);

    const turn = await harness.runtime.runAgentTurn("处理 T-1002。");
    expect(turn.status).toBe("completed");
    expect(prompts).toBe(0);
    expect(toolResultMessages(harness).every((r) => r.isError === false)).toBe(true);

    const routed = readTicket("T-1002");
    expect(routed.status).toBe("routed");
    expect(routed.queue).toBe("物流组");
    expect(routed.priority).toBe("P2");
  }, 60000);

  it("leaves the repo fixture untouched (tests only ever mutate a copy)", () => {
    expect(fs.readFileSync(path.join(supportDesk, "knowledge", "refund-policy.md"), "utf8")).toContain(REFUND_OLD);
    const original = JSON.parse(
      fs.readFileSync(path.join(supportDesk, "tickets", "T-1001.json"), "utf8"),
    ) as Ticket;
    expect(original.status).toBe("open");
    expect(original.queue).toBeUndefined();
  });
});
