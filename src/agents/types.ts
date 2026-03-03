import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Final result delivered from a finished worker back to the root agent. */
export interface WorkerReport {
  id: string;
  name: string;
  task: string;
  status: "running" | "completed" | "aborted" | "error";
  report: string;
  durationMs: number;
}

export type WorkerStatus = WorkerReport["status"];

/** Extract the final assistant text of a finished transcript. */
export function finalAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
    if (text.length > 0) return text;
    if (message.errorMessage) return `(assistant error: ${message.errorMessage})`;
  }
  return "(no response)";
}
