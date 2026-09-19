/**
 * Domain model for the customer-support workspace.
 *
 * A workspace holds two kinds of data:
 * - **tickets** (`tickets/<id>.json`) — the work items a triage agent processes;
 * - **knowledge articles** (`knowledge/<id>.md`) — the业务 SOP / policy documents
 *   the agent reads from and may propose edits to (always through Diff review).
 */

export type TicketStatus = "open" | "triaged" | "routed" | "escalated" | "resolved";
export type TicketPriority = "P0" | "P1" | "P2" | "P3";
export type TicketChannel = "email" | "chat" | "phone" | "web";

export interface TicketMessage {
  from: "customer" | "agent";
  text: string;
  at: string;
}

export interface TicketNote {
  text: string;
  at: string;
}

export interface Ticket {
  id: string;
  subject: string;
  customer: string;
  channel: TicketChannel;
  createdAt: string;
  /** Response SLA in minutes; used to derive urgency while triaging. */
  slaMinutes: number;
  status: TicketStatus;
  category?: string;
  priority?: TicketPriority;
  intent?: string;
  queue?: string;
  /** 0 = not escalated; 1 = 组长; 2 = 主管. */
  escalateLevel?: number;
  messages: TicketMessage[];
  notes?: TicketNote[];
}

export interface TicketSummary {
  id: string;
  subject: string;
  status: TicketStatus;
  priority?: TicketPriority;
  category?: string;
  queue?: string;
  customer: string;
  createdAt: string;
  slaMinutes: number;
}

export interface KnowledgeArticle {
  id: string;
  title: string;
  tags: string[];
  owner?: string;
  updatedAt?: string;
  /** Path relative to the workspace root, e.g. `knowledge/refund-policy.md`. */
  path: string;
  /** Markdown body (frontmatter stripped). */
  body: string;
  /** Full file text including frontmatter. */
  raw: string;
}

export interface TicketFilter {
  status?: TicketStatus;
  queue?: string;
  priority?: TicketPriority;
  category?: string;
  limit?: number;
}

export const TICKET_STATUSES: readonly TicketStatus[] = [
  "open",
  "triaged",
  "routed",
  "escalated",
  "resolved",
];

export const TICKET_PRIORITIES: readonly TicketPriority[] = ["P0", "P1", "P2", "P3"];
