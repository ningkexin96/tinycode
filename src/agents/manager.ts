import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { WorkerAgent } from "./worker.js";
import { finalAssistantText, type WorkerReport, type WorkerStatus } from "./types.js";

export interface SubAgentManagerOptions {
  projectRoot: string;
  model: Model<any>;
  streamFn: StreamFn;
  /** Read-only tools handed to every worker. */
  workerTools: AgentTool[];
  maxConcurrent?: number;
}

interface WorkerHandle {
  agent: WorkerAgent;
  report: WorkerReport;
  finished: Promise<void>;
}

/**
 * Spawns and supervises read-only worker agents. Hard cap on concurrency
 * prevents runaway agent swarms; workers cannot spawn further agents.
 */
export class SubAgentManager {
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly maxConcurrent: number;

  constructor(private readonly options: SubAgentManagerOptions) {
    this.maxConcurrent = options.maxConcurrent ?? 3;
  }

  get runningCount(): number {
    return [...this.workers.values()].filter((handle) => handle.report.status === "running").length;
  }

  /** Spawn one worker; rejects when the concurrency cap is reached. */
  spawn(name: string, task: string): WorkerReport {
    const id = nextId();
    if (!isValidName(name)) throw new Error("Worker name must be 1-40 characters: letters, digits, dashes.");
    if ([...this.workers.values()].some((handle) => handle.report.name === name)) {
      throw new Error(`A worker named "${name}" already exists. Use another name or close it first.`);
    }
    if (this.runningCount >= this.maxConcurrent) {
      throw new Error(
        `Sub-agent concurrency limit reached (${this.maxConcurrent} running). ` +
          `Use wait_agent to collect results or close_agent to free a slot.`,
      );
    }

    const agent = new WorkerAgent({
      projectRoot: this.options.projectRoot,
      model: this.options.model,
      streamFn: this.options.streamFn,
      tools: this.options.workerTools,
    });
    const startedAt = Date.now();
    const report: WorkerReport = { id, name, task, status: "running", report: "", durationMs: 0 };
    const handle: WorkerHandle = {
      agent,
      report,
      finished: (async () => {
        const abortSignal = agent.agent.signal ?? undefined;
        void abortSignal;
        try {
          await agent.runtime.prompt(task);
          if (agent.agent.signal?.aborted) {
            report.status = "aborted";
            report.report = "Worker was aborted.";
          } else {
            report.status = "completed";
            report.report = finalAssistantText(agent.agent.state.messages);
          }
        } catch (error) {
          report.status = "error";
          report.report = `Worker failed: ${(error as Error).message}`;
        } finally {
          report.durationMs = Date.now() - startedAt;
        }
      })(),
    };
    this.workers.set(id, handle);
    return report;
  }

  /** Resolve when the named worker (or all) finish; returns their reports. */
  async wait(id?: string): Promise<WorkerReport[]> {
    const targets = id
      ? [this.requireWorker(id)]
      : [...this.workers.values()].filter((handle) => !isSettled(handle));
    await Promise.all(targets.map((handle) => handle.finished));
    return this.reports();
  }

  close(id: string): WorkerReport {
    const handle = this.requireWorker(id);
    handle.agent.runtime.abort();
    return handle.report;
  }

  reports(): WorkerReport[] {
    return [...this.workers.values()].map((handle) => ({ ...handle.report }));
  }

  statusLine(): string {
    return `SUB-AGENTS ${this.runningCount}/${this.maxConcurrent} RUNNING`;
  }

  async shutdown(): Promise<void> {
    for (const handle of this.workers.values()) {
      if (handle.report.status === "running") handle.agent.runtime.abort();
    }
    await Promise.all([...this.workers.values()].map((handle) => handle.finished.catch(() => {})));
  }

  private requireWorker(idOrName: string): WorkerHandle {
    for (const handle of this.workers.values()) {
      if (handle.report.id === idOrName || handle.report.name === idOrName) return handle;
    }
    throw new Error(`Unknown sub-agent "${idOrName}". Use list_agents to see active workers.`);
  }
}

function isSettled(handle: WorkerHandle): boolean {
  return handle.report.status !== "running";
}

function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,39}$/.test(name);
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `w${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function statusLabel(status: WorkerStatus): string {
  switch (status) {
    case "running":
      return "● running";
    case "completed":
      return "✓ completed";
    case "aborted":
      return "■ aborted";
    case "error":
      return "✗ error";
  }
}
