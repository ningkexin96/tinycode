import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** First line of every session file. */
export interface SessionHeader {
  type: "session";
  id: string;
  cwd: string;
  createdAt: string;
  /** Display ref of the model used, e.g. "anthropic/claude-sonnet-4". */
  model: string;
  /** First user prompt snippet, for /sessions listing. */
  title?: string;
}

export type SessionRecord =
  | SessionHeader
  | { type: "message"; message: AgentMessage };

export interface SessionSummary {
  id: string;
  createdAt: string;
  modifiedAt: string;
  cwd: string;
  model: string;
  title?: string;
  messageCount: number;
}
