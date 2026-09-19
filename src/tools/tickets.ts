import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  listTickets,
  readTicket,
  searchTickets,
  summarizeTicket,
  writeTicket,
} from "../domain/tickets.js";
import type { Ticket } from "../domain/types.js";
import { nowIso, type DomainToolContext } from "./context.js";

const statusUnion = Type.Union([
  Type.Literal("open"),
  Type.Literal("triaged"),
  Type.Literal("routed"),
  Type.Literal("escalated"),
  Type.Literal("resolved"),
]);
const priorityUnion = Type.Union([
  Type.Literal("P0"),
  Type.Literal("P1"),
  Type.Literal("P2"),
  Type.Literal("P3"),
]);

/** A compact one-line-per-ticket listing used by list_tickets / search results. */
export function renderTicketLine(ticket: Ticket): string {
  const bits = [
    ticket.id,
    `[${ticket.status}]`,
    ticket.priority ? `${ticket.priority}` : "未定级",
    ticket.category ?? "未分类",
    ticket.queue ?? "未分流",
    `${ticket.slaMinutes}min`,
    `客户:${ticket.customer}`,
    ticket.subject,
  ];
  return bits.join(" · ");
}

/** Full ticket rendering (conversation + notes) used by get_ticket. */
export function renderTicket(ticket: Ticket): string {
  const lines: string[] = [
    `# 工单 ${ticket.id}`,
    `主题: ${ticket.subject}`,
    `客户: ${ticket.customer} · 渠道: ${ticket.channel} · 创建于 ${ticket.createdAt}`,
    `状态: ${ticket.status} · 分类: ${ticket.category ?? "未分类"} · 优先级: ${
      ticket.priority ?? "未定级"
    } · 队列: ${ticket.queue ?? "未分流"}`,
    `响应 SLA: ${ticket.slaMinutes} 分钟`,
  ];
  if (ticket.intent) lines.push(`意图: ${ticket.intent}`);
  if (typeof ticket.escalateLevel === "number" && ticket.escalateLevel > 0) {
    lines.push(`升级层级: L${ticket.escalateLevel}`);
  }
  lines.push("", "## 会话记录");
  for (const message of ticket.messages) {
    lines.push(`[${message.from === "customer" ? "客户" : "客服"}] ${message.at}`, message.text, "");
  }
  if (ticket.notes && ticket.notes.length > 0) {
    lines.push("## 内部备注");
    for (const note of ticket.notes) lines.push(`- ${note.at} ${note.text}`);
  }
  return lines.join("\n");
}

const listSchema = Type.Object({
  status: Type.Optional(statusUnion),
  queue: Type.Optional(Type.String({ description: "队列名过滤，例如 售后组" })),
  priority: Type.Optional(priorityUnion),
  category: Type.Optional(Type.String({ description: "分类过滤，例如 退款" })),
  limit: Type.Optional(Type.Number({ description: "最多返回多少条（默认全部）" })),
});

/** list_tickets — 盘点待办工单，分流前的第一步。 */
export function createListTicketsTool(ctx: DomainToolContext): AgentTool<typeof listSchema> {
  return {
    name: "list_tickets",
    label: "List Tickets",
    description:
      "列出工单，可按状态/队列/优先级/分类过滤。用于分流前盘点待处理工单。" +
      "只看某一条的完整内容请用 get_ticket。",
    parameters: listSchema,
    execute: async (_toolCallId, params) => {
      const tickets = listTickets(
        ctx.projectRoot,
        {
          status: params.status,
          queue: params.queue,
          priority: params.priority,
          category: params.category,
          limit: params.limit,
        },
        ctx.ticketsDir,
      );
      const lines = tickets.map(renderTicketLine);
      const text =
        tickets.length === 0
          ? "没有符合条件的工单。"
          : `${tickets.length} 条工单:\n${lines.map((line) => `- ${line}`).join("\n")}`;
      return {
        content: [{ type: "text", text }],
        details: { count: tickets.length, tickets: tickets.map(summarizeTicket) },
      };
    },
  };
}

const getSchema = Type.Object({
  ticket_id: Type.String({ description: "工单号，例如 T-1001" }),
});

/** get_ticket — 读取单条工单的完整会话与备注。 */
export function createGetTicketTool(ctx: DomainToolContext): AgentTool<typeof getSchema> {
  return {
    name: "get_ticket",
    label: "Get Ticket",
    description: "按工单号读取完整工单（会话记录、内部备注、当前分类/优先级/队列）。",
    parameters: getSchema,
    execute: async (_toolCallId, params) => {
      const ticket = readTicket(ctx.projectRoot, params.ticket_id, ctx.ticketsDir);
      return {
        content: [{ type: "text", text: renderTicket(ticket) }],
        details: { ticket },
      };
    },
  };
}

const searchSchema = Type.Object({
  query: Type.String({ description: "检索关键词，例如 退款 未收到货" }),
  status: Type.Optional(statusUnion),
  limit: Type.Optional(Type.Number({ description: "最多返回多少条（默认 10）" })),
});

/** search_tickets — 全文检索工单（主题 + 会话 + 备注）。 */
export function createSearchTicketsTool(ctx: DomainToolContext): AgentTool<typeof searchSchema> {
  return {
    name: "search_tickets",
    label: "Search Tickets",
    description: "在工单主题/会话/备注中做关键词检索，返回命中的工单与摘要片断。",
    parameters: searchSchema,
    execute: async (_toolCallId, params) => {
      const limit = params.limit ?? 10;
      const matches = searchTickets(
        ctx.projectRoot,
        params.query,
        { status: params.status, limit },
        ctx.ticketsDir,
      );
      const text =
        matches.length === 0
          ? `没有命中关键词「${params.query}」的工单。`
          : matches
              .map((match) => `- ${renderTicketLine(match.ticket)}\n  ↳ ${match.snippet}`)
              .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { count: matches.length, tickets: matches.map((m) => summarizeTicket(m.ticket)) },
      };
    },
  };
}

const classifySchema = Type.Object({
  ticket_id: Type.String({ description: "工单号" }),
  category: Type.String({ description: "业务分类，例如 退款/物流/账户/技术" }),
  priority: priorityUnion,
  intent: Type.String({ description: "客户意图的一句话概括" }),
  summary: Type.Optional(Type.String({ description: "给后续处理人的简要说明（写入内部备注）" })),
});

/** classify_ticket — 落盘分类/优先级/意图，状态推进为 triaged。 */
export function createClassifyTicketTool(ctx: DomainToolContext): AgentTool<typeof classifySchema> {
  return {
    name: "classify_ticket",
    label: "Classify Ticket",
    description:
      "为工单写入分类、优先级与意图，状态置为 triaged。判定结果必须落盘，" +
      "避免长会话中分类结论丢失。",
    parameters: classifySchema,
    execute: async (_toolCallId, params) => {
      const ticket = readTicket(ctx.projectRoot, params.ticket_id, ctx.ticketsDir);
      ticket.category = params.category;
      ticket.priority = params.priority;
      ticket.intent = params.intent;
      ticket.status = "triaged";
      if (params.summary && params.summary.trim().length > 0) {
        ticket.notes = [...(ticket.notes ?? []), { text: params.summary.trim(), at: nowIso(ctx) }];
      }
      writeTicket(ctx.projectRoot, ticket, ctx.ticketsDir);
      return {
        content: [
          {
            type: "text",
            text: `已归类 ${ticket.id}: 分类=${params.category} 优先级=${params.priority} 意图=${params.intent}（status→triaged）`,
          },
        ],
        details: {
          ticket_id: ticket.id,
          category: ticket.category,
          priority: ticket.priority,
          intent: ticket.intent,
          status: ticket.status,
        },
      };
    },
  };
}

const routeSchema = Type.Object({
  ticket_id: Type.String({ description: "工单号" }),
  queue: Type.String({ description: "目标队列，例如 售后组/物流组/技术支持" }),
  reason: Type.String({ description: "分流理由（写入内部备注，便于追溯）" }),
});

/** route_ticket — 把工单分流到目标队列，状态推进为 routed。 */
export function createRouteTicketTool(ctx: DomainToolContext): AgentTool<typeof routeSchema> {
  return {
    name: "route_ticket",
    label: "Route Ticket",
    description: "把工单分流到指定队列，状态置为 routed，并记录分流理由。",
    parameters: routeSchema,
    execute: async (_toolCallId, params) => {
      const ticket = readTicket(ctx.projectRoot, params.ticket_id, ctx.ticketsDir);
      ticket.queue = params.queue;
      ticket.status = "routed";
      ticket.notes = [
        ...(ticket.notes ?? []),
        { text: `分流到 ${params.queue}：${params.reason}`, at: nowIso(ctx) },
      ];
      writeTicket(ctx.projectRoot, ticket, ctx.ticketsDir);
      return {
        content: [{ type: "text", text: `已分流 ${ticket.id} → ${params.queue}（status→routed）` }],
        details: { ticket_id: ticket.id, queue: ticket.queue, status: ticket.status, reason: params.reason },
      };
    },
  };
}

const escalateSchema = Type.Object({
  ticket_id: Type.String({ description: "工单号" }),
  level: Type.Union([Type.Literal(1), Type.Literal(2)], {
    description: "升级层级：1=组长，2=主管",
  }),
  reason: Type.String({ description: "升级理由（写入内部备注）" }),
});

/** escalate_ticket — 触发升级判断结果，状态推进为 escalated。 */
export function createEscalateTicketTool(ctx: DomainToolContext): AgentTool<typeof escalateSchema> {
  return {
    name: "escalate_ticket",
    label: "Escalate Ticket",
    description:
      "把工单升级到 L1（组长）或 L2（主管），状态置为 escalated，并记录升级理由。" +
      "升级判断规则见 escalation SOP 技能。",
    parameters: escalateSchema,
    execute: async (_toolCallId, params) => {
      const ticket = readTicket(ctx.projectRoot, params.ticket_id, ctx.ticketsDir);
      ticket.escalateLevel = params.level;
      ticket.status = "escalated";
      ticket.notes = [
        ...(ticket.notes ?? []),
        { text: `升级到 L${params.level}：${params.reason}`, at: nowIso(ctx) },
      ];
      writeTicket(ctx.projectRoot, ticket, ctx.ticketsDir);
      return {
        content: [{ type: "text", text: `已升级 ${ticket.id} → L${params.level}（status→escalated）` }],
        details: { ticket_id: ticket.id, level: params.level, status: ticket.status, reason: params.reason },
      };
    },
  };
}

const replySchema = Type.Object({
  ticket_id: Type.String({ description: "工单号" }),
  message: Type.String({ description: "发给客户的话术正文（会在人工审批后写入会话）" }),
});

/** reply_customer — 生成并记录对客户的回复（经人工审批）。 */
export function createReplyCustomerTool(ctx: DomainToolContext): AgentTool<typeof replySchema> {
  return {
    name: "reply_customer",
    label: "Reply Customer",
    description:
      "给客户发送一段回复，写入工单会话记录。属对外动作，需人工审批后才会落盘。",
    parameters: replySchema,
    execute: async (_toolCallId, params) => {
      const ticket = readTicket(ctx.projectRoot, params.ticket_id, ctx.ticketsDir);
      ticket.messages = [...ticket.messages, { from: "agent", text: params.message, at: nowIso(ctx) }];
      writeTicket(ctx.projectRoot, ticket, ctx.ticketsDir);
      return {
        content: [{ type: "text", text: `已记录对 ${ticket.id} 的客户回复（${params.message.length} 字）。` }],
        details: { ticket_id: ticket.id, length: params.message.length },
      };
    },
  };
}
