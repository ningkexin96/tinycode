export interface SkillSummaryView {
  name: string;
  description: string;
}

export interface SystemPromptInput {
  projectRoot: string;
  platform: string;
  memory?: string;
  skills?: SkillSummaryView[];
  /** Business queues the agent may route to (from config). */
  queues?: string[];
  knowledgeDir?: string;
  ticketsDir?: string;
}

/**
 * System prompt builder for the 客服工单分流 (customer-support ticket triage)
 * agent.
 *
 * Kept deliberately short: deterministic rules (permissions, Diff review,
 * truncation) live in the harness, not in the prompt. Business SOPs are NOT
 * inlined here — they load on demand through the Skills mechanism, so the
 * context window never carries the full rulebook.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const knowledgeDir = input.knowledgeDir && input.knowledgeDir.length > 0 ? input.knowledgeDir : "knowledge";
  const ticketsDir = input.ticketsDir && input.ticketsDir.length > 0 ? input.ticketsDir : "tickets";

  const sections: string[] = [];

  sections.push(
    `你是 TinyCode，一名客服工单分流（triage）业务智能体，工作在客服工作区 ${input.projectRoot}。`,
    "你的职责：读懂工单 → 依据知识库 SOP 判定分类/优先级/意图 → 把工单分流到正确队列，必要时升级。",
    "",
    "## 工作原则",
    "- 先取证再判断：用 list_tickets / get_ticket / search_tickets 看清工单，用 search_knowledge / read_article 查 SOP。",
    "- 判定必须落盘：分类、优先级、意图用 classify_ticket 写入，避免长会话中结论丢失。",
    "- 分流要有据：route_ticket 必须给出目标队列与理由；是否升级依据升级规则 SOP。",
    "- 知识库只读改：任何知识库改动都必须走 propose_knowledge_edit（生成 Diff 并交人工审批），绝不臆造或绕过审批直接改政策。",
    "- 对客回复（reply_customer）属对外动作，同样需人工审批；未获批准不要对外承诺。",
    "- 只汇报你验证过的结论；信息不足时追问或升级，不要编造政策条款。",
    "",
    "## 环境",
    `- 工作区根目录: ${input.projectRoot}`,
    `- 工单目录: ${ticketsDir}/ （每条工单一个 JSON）`,
    `- 知识库目录: ${knowledgeDir}/ （每篇 SOP 一个 Markdown）`,
    `- 平台: ${input.platform}`,
  );

  if (input.queues && input.queues.length > 0) {
    sections.push(`- 可分流队列: ${input.queues.join(" / ")}`);
  }

  sections.push(
    "",
    "## 工具",
    "- 查询：list_tickets / get_ticket / search_tickets（工单）、search_knowledge / read_article（知识库）。",
    "- 处理：classify_ticket（分类分级）、route_ticket（分流）、escalate_ticket（升级）、reply_customer（回复）。",
    "- 知识库写入：propose_knowledge_edit —— 生成统一 Diff，交由人工审批；改动为空会短路跳过。",
    "- 技能：load_skill —— 当系统提示里列出的技能与当前工单相关时，按需加载完整 SOP。",
  );

  if (input.memory && input.memory.trim().length > 0) {
    sections.push(
      "",
      "## 业务规则（TINY.md）",
      "以下规则来自工作区维护者：",
      "",
      input.memory.trim(),
    );
  }

  if (input.skills && input.skills.length > 0) {
    const list = input.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
    sections.push(
      "",
      "## 技能（渐进式加载）",
      "以下技能仅提供摘要；需要完整 SOP 时用 load_skill 按需加载：",
      list,
    );
  }

  return sections.join("\n");
}
