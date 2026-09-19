/**
 * Static permission rules for the customer-support domain.
 *
 * The gate runs BEFORE a tool executes, so these verdicts decide whether a call
 * proceeds freely, needs human approval, or is refused. The core policy for a
 * ticket-triage agent:
 *
 * - 只读查询（查工单/查知识库）→ 放行，保证长会话可自由取证；
 * - 常规分流记账（分类/路由）→ 放行，这是 Agent 的本职工作；
 * - 对客回复、升级到主管、**知识库写入** → ASK，必须人工审批；
 * - 知识库改动为空（old_text === new_text）→ 短路跳过，不占用审批。
 */

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRuleInput {
  toolName: string;
  input: Record<string, unknown>;
  projectRoot: string;
}

export interface RuleVerdict {
  action: PermissionAction;
  reason: string;
}

/** Tools that only read workspace data — safe to run unattended. */
const READ_ONLY_TOOLS = new Set([
  "list_tickets",
  "get_ticket",
  "search_tickets",
  "search_knowledge",
  "read_article",
  "load_skill",
]);

/** Routine triage bookkeeping — the agent's own job, no approval needed. */
const TRIAGE_TOOLS = new Set(["classify_ticket", "route_ticket"]);

/** Tools whose approval must not be turned into a remembered "always allow". */
export const REVIEW_REQUIRED_TOOLS = new Set(["propose_knowledge_edit"]);

/** A knowledge edit that changes nothing is short-circuited (no review). */
export function isNoopKnowledgeEdit(input: Record<string, unknown>): boolean {
  return (
    typeof input.old_text === "string" &&
    typeof input.new_text === "string" &&
    input.old_text === input.new_text
  );
}

export function evaluateRules({ toolName, input }: PermissionRuleInput): RuleVerdict {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { action: "allow", reason: "只读查询" };
  }

  if (TRIAGE_TOOLS.has(toolName)) {
    return { action: "allow", reason: "常规分流操作（分类/路由）" };
  }

  if (toolName === "escalate_ticket") {
    const level = Number(input.level ?? 1);
    if (level >= 2) {
      return { action: "ask", reason: "升级到主管（L2）需人工确认" };
    }
    return { action: "allow", reason: "升级到组长（L1）" };
  }

  if (toolName === "reply_customer") {
    return { action: "ask", reason: "对客回复属对外动作，需人工审批" };
  }

  if (toolName === "propose_knowledge_edit") {
    if (isNoopKnowledgeEdit(input)) {
      return { action: "allow", reason: "知识库改动为空，短路跳过" };
    }
    return { action: "ask", reason: "知识库写入需人工审批（Diff 审查）" };
  }

  // Tools registered later (MCP, sub-agents, skills) default to asking.
  return { action: "ask", reason: `未分类工具 "${toolName}"` };
}
