import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStorage } from "../src/session/storage.js";
import { SessionManager } from "../src/session/manager.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sessions-"));
});

function userMessage(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "mock",
    provider: "mock",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("SessionStorage", () => {
  it("round-trips header and messages", () => {
    const storage = new SessionStorage(dir);
    const header = storage.create({ id: "s1", cwd: "/p", createdAt: "now", model: "a/b", title: "t" });
    expect(header.type).toBe("session");
    storage.appendMessage("s1", userMessage("hello"));
    storage.appendMessage("s1", assistantMessage("hi"));

    const loaded = storage.load("s1")!;
    expect(loaded.header.id).toBe("s1");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0]).toMatchObject({ role: "user", content: "hello" });
  });

  it("returns undefined for unknown sessions and tolerates torn lines", () => {
    const storage = new SessionStorage(dir);
    expect(storage.load("nope")).toBeUndefined();

    storage.create({ id: "s2", cwd: "/p", createdAt: "now", model: "a/b" });
    fs.appendFileSync(path.join(dir, "s2.jsonl"), `{"type":"message","message":{"role":"user"\n`);
    const loaded = storage.load("s2")!;
    expect(loaded.header.id).toBe("s2");
    expect(loaded.messages).toHaveLength(0);
  });

  it("lists sessions newest-first", () => {
    const storage = new SessionStorage(dir);
    storage.create({ id: "aaa", cwd: "/p", createdAt: "2024-01-01T00:00:00Z", model: "m" });
    storage.create({ id: "bbb", cwd: "/q", createdAt: "2024-01-02T00:00:00Z", model: "m" });
    // Deterministic mtimes: aaa older than bbb.
    const timeA = new Date("2024-01-01T00:00:00Z");
    const timeB = new Date("2024-01-02T00:00:00Z");
    fs.utimesSync(path.join(dir, "aaa.jsonl"), timeA, timeA);
    fs.utimesSync(path.join(dir, "bbb.jsonl"), timeB, timeB);
    const list = storage.list();
    expect(list.map((entry) => entry.id)).toEqual(["bbb", "aaa"]);
  });
});

describe("SessionManager", () => {
  it("records messages into the active session", () => {
    const manager = new SessionManager(dir);
    const id = manager.start("/proj", "mock/m");
    manager.record(userMessage("fix the bug"));
    manager.record(assistantMessage("done"));

    const loaded = manager.load(id)!;
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.header.title).toBe("fix the bug");
  });

  it("attach restores the transcript without touching the file", () => {
    const writer = new SessionManager(dir);
    const id = writer.start("/proj", "old/model");
    writer.record(userMessage("task one"));
    writer.record(assistantMessage("worked"));
    const before = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf8");

    const reader = new SessionManager(dir);
    const restored = reader.attach(id, "/proj", "new/model");
    expect(restored.messages).toHaveLength(2);

    // Append-only guarantee: attach must not truncate or rewrite history,
    // so a crash during attach can never destroy a session.
    const after = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf8");
    expect(after).toBe(before);

    // New records keep appending to the attached file.
    reader.record(userMessage("post-attach"));
    const lines = after.trim().split("\n").length;
    expect(fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf8").trim().split("\n")).toHaveLength(lines + 1);
  });

  it("record survives storage failures without throwing", () => {
    const manager = new SessionManager(dir);
    const id = manager.start("/proj", "m");
    fs.rmSync(path.join(dir, `${id}.jsonl`));
    manager.record(userMessage("dropped"));
    // No throw; session continues in memory.
    expect(manager.id).toBe(id);
  });
});
