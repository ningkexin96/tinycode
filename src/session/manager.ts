import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { SessionStorage } from "./storage.js";
import type { SessionSummary } from "./types.js";

/**
 * SessionManager binds storage to the live conversation: it records finalized
 * messages and can rebuild an agent transcript from a previous session file.
 */
export class SessionManager {
  readonly storage: SessionStorage;
  private currentId?: string;
  private meta?: { cwd: string; model: string; createdAt: string; titleSet: boolean };
  private lastUserText = "…";

  constructor(storageDir: string) {
    this.storage = new SessionStorage(storageDir);
  }

  get id(): string | undefined {
    return this.currentId;
  }

  /** Start a fresh session file. */
  start(cwd: string, model: string): string {
    this.currentId = uuidv7();
    const createdAt = new Date().toISOString();
    this.storage.create({ id: this.currentId, cwd, createdAt, model });
    this.meta = { cwd, model, createdAt, titleSet: false };
    return this.currentId;
  }

  /**
   * Attach to an existing session (used by --continue / --session / /resume).
   *
   * The file is left untouched — attach is read-only. Rewriting the header
   * plus full history here would risk truncating the session if the process
   * died between truncate and re-append; the stored header stays canonical.
   */
  attach(id: string, _cwd: string, _model: string): { messages: AgentMessage[] } {
    const loaded = this.storage.load(id);
    if (!loaded) throw new Error(`Session not found: ${id}`);
    this.currentId = id;
    const firstUser = loaded.messages.find((message) => message.role === "user");
    if (firstUser && firstUser.role === "user" && typeof firstUser.content === "string") {
      this.lastUserText = firstUser.content.replace(/\s+/g, " ").slice(0, 80);
    }
    this.meta = { cwd: loaded.header.cwd, model: loaded.header.model, createdAt: loaded.header.createdAt, titleSet: true };
    return { messages: loaded.messages };
  }

  record(message: AgentMessage): void {
    if (!this.currentId || !this.meta) return;
    if (!this.meta.titleSet && message.role === "user") {
      const text = extractUserText(message);
      // Persist a human-readable title once the first real prompt arrives.
      if (!text) {
        this.storage.appendMessage(this.currentId, message);
        return;
      }
      this.lastUserText = text;
      try {
        this.storage.create({
          id: this.currentId,
          cwd: this.meta.cwd,
          createdAt: this.meta.createdAt,
          model: this.meta.model,
          title: text,
        });
        this.meta.titleSet = true;
      } catch {
        // fall through: title stays in-memory only
      }
    }
    try {
      this.storage.appendMessage(this.currentId, message);
    } catch {
      // Persistence must never crash the live session.
    }
  }

  list(): SessionSummary[] {
    return this.storage.list();
  }

  load(id: string) {
    return this.storage.load(id);
  }
}

/** User prompts arrive as plain strings or text-block arrays (pi normalization). */
function extractUserText(message: AgentMessage): string | undefined {
  if (!("content" in message)) return undefined;
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: string }).text) : ""))
      .join(" ")
      .trim();
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

