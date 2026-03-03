import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionHeader, SessionRecord, SessionSummary } from "./types.js";

/**
 * Append-only JSONL storage: one file per session under <dir>/<id>.jsonl.
 * Line 1 is always the session header; every following line is a message.
 * Appends are flushed synchronously so sessions survive hard kills.
 */
export class SessionStorage {
  constructor(private readonly dir: string) {}

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  create(header: Omit<SessionHeader, "type">): SessionHeader {
    this.init();
    const full: SessionHeader = { type: "session", ...header };
    fs.writeFileSync(this.fileOf(header.id), `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  appendMessage(id: string, message: AgentMessage): void {
    const record: SessionRecord = { type: "message", message };
    fs.appendFileSync(this.fileOf(id), `${JSON.stringify(record)}\n`, "utf8");
  }

  exists(id: string): boolean {
    return fs.existsSync(this.fileOf(id));
  }

  /** Parse one session file; tolerant to a torn final line (crash during append). */
  load(id: string): { header: SessionHeader; messages: AgentMessage[] } | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.fileOf(id), "utf8");
    } catch {
      return undefined;
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) return undefined;

    let header: SessionHeader | undefined;
    const messages: AgentMessage[] = [];
    for (const line of lines) {
      let parsed: SessionRecord;
      try {
        parsed = JSON.parse(line) as SessionRecord;
      } catch {
        continue; // skip torn/corrupt lines instead of losing the whole session
      }
      if (parsed.type === "session") header = parsed;
      else if (parsed.type === "message") messages.push(parsed.message);
    }
    if (!header) return undefined;
    return { header, messages };
  }

  /** Newest-first summaries of all sessions in storage. */
  list(): SessionSummary[] {
    this.init();
    const summaries: SessionSummary[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      const loaded = this.load(id);
      if (!loaded) continue;
      let modifiedAt = loaded.header.createdAt;
      try {
        modifiedAt = fs.statSync(this.fileOf(id)).mtime.toISOString();
      } catch {
        // keep createdAt
      }
      summaries.push({
        id,
        createdAt: loaded.header.createdAt,
        modifiedAt,
        cwd: loaded.header.cwd,
        model: loaded.header.model,
        title: loaded.header.title,
        messageCount: loaded.messages.length,
      });
    }
    summaries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return summaries;
  }
}
