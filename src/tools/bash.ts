import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { resolveWorkspacePath } from "./paths.js";

const MAX_CAPTURE_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory relative to the project root (default: project root)" }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` }),
  ),
});

export interface BashDetails {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Capture a stream keeping head and tail when output exceeds the cap.
 * Long build/test logs have context at the start and errors at the end.
 */
class Capture {
  private head = "";
  private tail = "";
  private dropped = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  write(chunk: string): void {
    const combined = this.head + chunk + this.tail;
    if (combined.length <= this.cap) {
      this.head = combined;
      this.tail = "";
      return;
    }
    const overflow = combined.length - this.cap;
    this.dropped += overflow;
    this.truncated = true;
    // Keep cap/2 at each end.
    const keep = Math.floor(this.cap / 2);
    const text = this.head + chunk + this.tail;
    this.head = text.slice(0, keep);
    this.tail = text.slice(text.length - keep);
  }

  render(): string {
    if (this.dropped === 0) return `${this.head}${this.tail}`;
    return `${this.head}\n…\n${this.tail}\n[output truncated: ${this.dropped} characters omitted]`;
  }
}

/**
 * bash(command, cwd?, timeoutMs?) — run a shell command inside the project.
 * Supports timeout and AbortSignal; output is captured and capped.
 */
export function createBashTool(projectRoot: string): AgentTool<typeof bashSchema> {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a shell command in the project directory. Returns exit code, stdout, stderr and duration. " +
      "Dangerous commands require user approval. Use for builds, tests and git inspection.",
    parameters: bashSchema,
    execute: async (_toolCallId, params, signal) => {
      const cwdAbsolute = resolveWorkspacePath(projectRoot, params.cwd ?? ".");
      const timeoutMs = Math.min(Math.max(1, params.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);

      const stdout = new Capture(MAX_CAPTURE_CHARS);
      const stderr = new Capture(MAX_CAPTURE_CHARS);
      const startedAt = Date.now();

      const child = spawn("bash", ["-c", params.command], {
        cwd: cwdAbsolute,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let settled = false;
      let timedOut = false;
      const escalate = () => {
        setTimeout(() => {
          if (!settled && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 2000).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        escalate();
      }, timeoutMs);

      const abortListener = () => {
        child.kill("SIGTERM");
        escalate();
      };
      signal?.addEventListener("abort", abortListener, { once: true });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => stdout.write(chunk));
      child.stderr.on("data", (chunk: string) => stderr.write(chunk));

      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, sig) => resolve({ code, signal: sig }));
        },
      );
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);

      const durationMs = Date.now() - startedAt;
      const details: BashDetails = {
        command: params.command,
        exitCode: result.code,
        signal: result.signal,
        timedOut,
        durationMs,
      };

      const sections: string[] = [];
      if (timedOut) {
        sections.push(`✗ TIMEOUT after ${timeoutMs}ms · killed`);
      } else if (result.signal) {
        sections.push(`✗ terminated by signal ${result.signal} · ${(durationMs / 1000).toFixed(1)}s`);
      } else if (result.code === 0) {
        sections.push(`✓ exit 0 · ${(durationMs / 1000).toFixed(1)}s`);
      } else {
        sections.push(`✗ exit ${result.code} · ${(durationMs / 1000).toFixed(1)}s`);
      }
      const out = stdout.render().trim();
      const err = stderr.render().trim();
      if (out.length > 0) sections.push(`stdout:\n${out}`);
      if (err.length > 0) sections.push(`stderr:\n${err}`);

      return { content: [{ type: "text", text: sections.join("\n") }], details };
    },
  };
}
