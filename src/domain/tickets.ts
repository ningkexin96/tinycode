import fs from "node:fs";
import path from "node:path";
import { sanitizeId } from "../util/ids.js";
import { scoreTerms, snippetFor, tokenize } from "./search.js";
import type { Ticket, TicketFilter, TicketSummary } from "./types.js";

export const DEFAULT_TICKETS_DIR = "tickets";

/** Absolute ticket directory for a workspace. */
export function ticketsRoot(projectRoot: string, dirName?: string): string {
  const dir = dirName && dirName.trim().length > 0 ? dirName.trim() : DEFAULT_TICKETS_DIR;
  return path.join(projectRoot, dir);
}

/** Absolute path of one ticket file (`<id>.json`). */
export function ticketFilePath(projectRoot: string, id: string, dirName?: string): string {
  return path.join(ticketsRoot(projectRoot, dirName), `${sanitizeId(id)}.json`);
}

/** Load every ticket in the workspace (unreadable files are skipped, not fatal). */
export function listTickets(projectRoot: string, filter: TicketFilter = {}, dirName?: string): Ticket[] {
  const dir = ticketsRoot(projectRoot, dirName);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const tickets: Ticket[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8")) as Ticket;
      if (parsed && typeof parsed.id === "string") tickets.push(parsed);
    } catch {
      // A malformed ticket file must not take the whole triage run down.
    }
  }
  const filtered = tickets.filter((ticket) => matchesFilter(ticket, filter));
  filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return typeof filter.limit === "number" && filter.limit > 0 ? filtered.slice(0, filter.limit) : filtered;
}

function matchesFilter(ticket: Ticket, filter: TicketFilter): boolean {
  if (filter.status && ticket.status !== filter.status) return false;
  if (filter.queue && ticket.queue !== filter.queue) return false;
  if (filter.priority && ticket.priority !== filter.priority) return false;
  if (filter.category && ticket.category !== filter.category) return false;
  return true;
}

/** Read one ticket by id; throws a model-friendly error when missing. */
export function readTicket(projectRoot: string, id: string, dirName?: string): Ticket {
  const file = ticketFilePath(projectRoot, id, dirName);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`工单不存在: ${id}（请先用 list_tickets 或 search_tickets 确认工单号）`);
  }
  try {
    return JSON.parse(raw) as Ticket;
  } catch (error) {
    throw new Error(`工单 ${id} 文件不是合法 JSON: ${(error as Error).message}`);
  }
}

/** Persist a ticket back to disk. */
export function writeTicket(projectRoot: string, ticket: Ticket, dirName?: string): void {
  const file = ticketFilePath(projectRoot, ticket.id, dirName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ticket, null, 2)}\n`, "utf8");
}

export function summarizeTicket(ticket: Ticket): TicketSummary {
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    queue: ticket.queue,
    customer: ticket.customer,
    createdAt: ticket.createdAt,
    slaMinutes: ticket.slaMinutes,
  };
}

export interface TicketMatch {
  ticket: Ticket;
  snippet: string;
}

/** Ranked full-text search over ticket subject + messages + notes. */
export function searchTickets(
  projectRoot: string,
  query: string,
  filter: TicketFilter = {},
  dirName?: string,
): TicketMatch[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const scored: Array<TicketMatch & { score: number }> = [];
  for (const ticket of listTickets(projectRoot, filter, dirName)) {
    const haystack = [
      ticket.id,
      ticket.subject,
      ticket.customer,
      ticket.category ?? "",
      ...ticket.messages.map((message) => message.text),
      ...(ticket.notes ?? []).map((note) => note.text),
    ]
      .join("\n")
      .toLowerCase();
    const score = scoreTerms(haystack, terms);
    if (score === 0) continue;
    const snippetSource = [ticket.subject, ...ticket.messages.map((message) => message.text)].join("\n");
    scored.push({ ticket, snippet: snippetFor(snippetSource, terms), score });
  }
  scored.sort((a, b) => b.score - a.score || a.ticket.id.localeCompare(b.ticket.id));
  return scored.map(({ ticket, snippet }) => ({ ticket, snippet }));
}
