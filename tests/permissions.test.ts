import { describe, expect, it } from "vitest";
import {
  REVIEW_REQUIRED_TOOLS,
  evaluateRules,
  isNoopKnowledgeEdit,
} from "../src/permissions/rules.js";
import { PermissionManager } from "../src/permissions/manager.js";

/**
 * Static policy matrix for the customer-support triage agent.
 *
 *   read-only lookups + triage bookkeeping (classify/route) → allow
 *   escalation L2 / customer reply / knowledge-base writes  → ask
 *   short-circuited no-op knowledge edit                    → allow
 *   unknown tools (MCP, sub-agents, future)                 → ask
 */

const projectRoot = "/proj/support-desk";

function verdict(toolName: string, input: Record<string, unknown> = {}) {
  return evaluateRules({ toolName, input, projectRoot });
}

describe("rule matrix — read-only lookups", () => {
  it("allows every query tool without approval", () => {
    for (const toolName of [
      "list_tickets",
      "get_ticket",
      "search_tickets",
      "search_knowledge",
      "read_article",
      "load_skill",
    ]) {
      expect(verdict(toolName).action, toolName).toBe("allow");
    }
  });

  it("allows filtered ticket listing as well", () => {
    expect(verdict("list_tickets", { status: "open", queue: "售后组" }).action).toBe("allow");
    expect(verdict("search_tickets", { query: "退款" }).action).toBe("allow");
    expect(verdict("read_article", { article_id: "refund-policy" }).action).toBe("allow");
  });
});

describe("rule matrix — triage bookkeeping", () => {
  it("allows classify_ticket and route_ticket (the agent's own job)", () => {
    expect(verdict("classify_ticket", { ticket_id: "T-1001", category: "退款", priority: "P1" }).action).toBe(
      "allow",
    );
    expect(verdict("route_ticket", { ticket_id: "T-1001", queue: "售后组" }).action).toBe("allow");
  });
});

describe("rule matrix — escalation levels", () => {
  it("allows L1 escalation and asks for L2", () => {
    expect(verdict("escalate_ticket", { ticket_id: "T-1003", level: 1 }).action).toBe("allow");
    expect(verdict("escalate_ticket", { ticket_id: "T-1003", level: 2 }).action).toBe("ask");
    // A missing level defaults to L1.
    expect(verdict("escalate_ticket", { ticket_id: "T-1003" }).action).toBe("allow");
  });

  it("explains why L2 needs a human", () => {
    expect(verdict("escalate_ticket", { level: 2 }).reason).toContain("L2");
  });
});

describe("rule matrix — outward-facing actions", () => {
  it("asks before replying to a customer", () => {
    const action = verdict("reply_customer", { ticket_id: "T-1001", message: "已为您处理" });
    expect(action.action).toBe("ask");
    expect(action.reason).toContain("人工审批");
  });

  it("asks before a real knowledge-base write", () => {
    const action = verdict("propose_knowledge_edit", {
      article_id: "refund-policy",
      old_text: "7 个工作日",
      new_text: "3 个工作日",
      rationale: "政策已更新",
    });
    expect(action.action).toBe("ask");
    expect(action.reason).toContain("Diff");
  });

  it("short-circuits an edit that changes nothing", () => {
    const same = "退款审核通过后，款项在 7 个工作日内退回原支付渠道。";
    const action = verdict("propose_knowledge_edit", {
      article_id: "refund-policy",
      old_text: same,
      new_text: same,
      rationale: "无变化",
    });
    expect(action.action).toBe("allow");
    expect(action.reason).toContain("短路");
  });
});

describe("isNoopKnowledgeEdit", () => {
  it("detects identical old_text/new_text only", () => {
    expect(isNoopKnowledgeEdit({ old_text: "a", new_text: "a" })).toBe(true);
    expect(isNoopKnowledgeEdit({ old_text: "a", new_text: "b" })).toBe(false);
    expect(isNoopKnowledgeEdit({ old_text: "a" })).toBe(false);
    expect(isNoopKnowledgeEdit({ new_text: "a" })).toBe(false);
    expect(isNoopKnowledgeEdit({ old_text: 1, new_text: 1 })).toBe(false);
    expect(isNoopKnowledgeEdit({})).toBe(false);
  });
});

describe("unknown tools", () => {
  it("defaults to ask so nothing new is auto-approved", () => {
    for (const toolName of ["mcp__github__search", "spawn_agent", "mystery_tool"]) {
      expect(verdict(toolName).action, toolName).toBe("ask");
    }
  });
});

describe("REVIEW_REQUIRED_TOOLS", () => {
  it("keeps knowledge edits out of the remembered-always fast path", () => {
    expect(REVIEW_REQUIRED_TOOLS.has("propose_knowledge_edit")).toBe(true);
    expect(REVIEW_REQUIRED_TOOLS.has("reply_customer")).toBe(false);
  });
});

describe("PermissionManager", () => {
  it("auto-approves asks in auto mode", async () => {
    const manager = new PermissionManager({ mode: "auto", projectRoot: "/p" });
    const decision = await manager.check("reply_customer", { ticket_id: "T-1001", message: "hi" });
    expect(decision.action).toBe("allow");
    expect(decision.reason).toContain("auto-approved");
  });

  it("never prompts for allow-level tools", async () => {
    const prompts: string[] = [];
    const manager = new PermissionManager({
      mode: "ask",
      projectRoot: "/p",
      prompt: async (request) => {
        prompts.push(request.toolName);
        return "deny";
      },
    });

    expect((await manager.check("list_tickets", {})).action).toBe("allow");
    expect((await manager.check("classify_ticket", { ticket_id: "T-1001" })).action).toBe("allow");
    expect((await manager.check("escalate_ticket", { ticket_id: "T-1001", level: 1 })).action).toBe("allow");
    // No-op knowledge edits are short-circuited too.
    expect(
      (
        await manager.check("propose_knowledge_edit", {
          article_id: "refund-policy",
          old_text: "same",
          new_text: "same",
        })
      ).action,
    ).toBe("allow");
    expect(prompts).toEqual([]);
  });

  it("prompts for ASK tools, remembers reply approvals and denies on deny", async () => {
    const prompts: string[] = [];
    let answer: "once" | "always" | "deny" = "once";
    const manager = new PermissionManager({
      mode: "ask",
      projectRoot: "/p",
      prompt: async (request) => {
        prompts.push(request.toolName);
        return answer;
      },
    });

    expect((await manager.check("reply_customer", { ticket_id: "T-1001", message: "hi" })).action).toBe("allow");
    expect(prompts).toEqual(["reply_customer"]);

    answer = "always";
    await manager.check("reply_customer", { ticket_id: "T-1001", message: "again" });
    expect(prompts).toHaveLength(2);
    expect((await manager.check("reply_customer", { ticket_id: "T-1001", message: "again" })).reason).toContain(
      "remembered",
    );
    expect(prompts).toHaveLength(2);

    answer = "deny";
    const denied = await manager.check("escalate_ticket", { ticket_id: "T-1001", level: 2 });
    expect(denied.action).toBe("deny");
    expect(denied.reason).toContain("denied by user");
  });

  it("does not remember 'always' for knowledge edits (every diff is reviewed)", async () => {
    let prompts = 0;
    const manager = new PermissionManager({
      mode: "ask",
      projectRoot: "/p",
      prompt: async () => {
        prompts += 1;
        return "always";
      },
    });
    const input = {
      article_id: "refund-policy",
      old_text: "7 个工作日",
      new_text: "3 个工作日",
      rationale: "政策更新",
    };

    expect((await manager.check("propose_knowledge_edit", input)).action).toBe("allow");
    expect(manager.listPatterns()).toHaveLength(0);
    await manager.check("propose_knowledge_edit", input);
    expect(prompts).toBe(2);
  });

  it("denies safely when no prompt callback exists", async () => {
    const manager = new PermissionManager({ mode: "ask", projectRoot: "/p" });
    const decision = await manager.check("reply_customer", { ticket_id: "T-1001", message: "hi" });
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("no permission prompt available");
  });

  it("denies ASK tools when the prompt callback throws", async () => {
    const manager = new PermissionManager({
      mode: "ask",
      projectRoot: "/p",
      prompt: async () => {
        throw new Error("dialog crashed");
      },
    });
    const decision = await manager.check("escalate_ticket", { level: 2 });
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("dialog crashed");
  });

  it("setMode switches behavior at runtime", async () => {
    const manager = new PermissionManager({ mode: "ask", projectRoot: "/p" });
    expect((await manager.check("reply_customer", { message: "hi" })).action).toBe("deny");
    manager.setMode("auto");
    expect((await manager.check("reply_customer", { message: "hi" })).action).toBe("allow");
  });
});
