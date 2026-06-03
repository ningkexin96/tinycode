import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { IPty } from "node-pty";

/**
 * Interactive TUI PTY smoke test.
 *
 * Proves the full loop in a real pseudo-terminal:
 *   launch CLI → banner renders → keyboard input → mock model response
 *   renders → clean exit with code 0 (no hang, no uncaught exception).
 *
 * Runs wherever node-pty builds: Linux CI and macOS. Windows lacks a stable
 * ConPTY story for this harness and is skipped deliberately.
 *
 * NOTE on wall-clock waiting: the subject is a separate OS process driven
 * through a kernel PTY — its timing cannot be controlled with fake timers,
 * so conditions are polled against real output with hard ceilings.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "dist", "cli", "index.js");

// The test drives the built artifact; build once if missing (fresh clones).
beforeAll(() => {
  if (!fs.existsSync(cli)) {
    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: projectRoot, stdio: "pipe" });
  }
  expect(fs.existsSync(cli)).toBe(true);
});

const canRunPty = process.platform !== "win32";

function stripAnsi(text: string): string {
   
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
}

interface Session {
  term: IPty;
  output(): string;
  exited: Promise<{ code: number; signal: number | undefined }>;
}

async function spawnTui(env: Record<string, string>, cwd: string, cols = 120, rows = 40): Promise<Session> {
  const { default: pty } = await import("node-pty");
  const { promise: exited, resolve } = Promise.withResolvers<{ code: number; signal: number | undefined }>();
  let buffer = "";
  const term = pty.spawn(process.execPath, [cli], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
  });
  term.onData((data) => {
    buffer += data;
  });
  term.onExit(({ exitCode, signal }) => resolve({ code: exitCode, signal }));
  return { term, output: () => buffer, exited };
}

async function waitFor(probe: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!probe()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`PTY smoke timeout waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function makeEnv(home: string, stripProviderKeys = false): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    TINYCODE_MODEL: "mock",
    TINYCODE_HOME: home,
    TERM: "xterm-256color",
  } as Record<string, string>;
  if (stripProviderKeys) {
    for (const key of Object.keys(env)) {
      if (/API_KEY$|_TOKEN$/.test(key)) delete env[key];
    }
    delete env.TINYCODE_MODEL; // let resolution fail so onboarding kicks in
  }
  return env;
}

describe.skipIf(!canRunPty)("interactive TUI PTY smoke", () => {
  it("launches, echoes input, receives mock response, exits cleanly via /exit", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-pty-home-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-pty-proj-"));
    fs.writeFileSync(path.join(workdir, "note.txt"), "hello from fixture\n");

    const session = await spawnTui(makeEnv(home), workdir);
    try {
      await waitFor(() => stripAnsi(session.output()).includes("TinyCode v1.0"), 20_000, "startup banner");

      // Write text first, then Enter once the editor has rendered it:
      // bracketed-paste mode treats one combined write as a paste insertion,
      // not a submit keystroke.
      session.term.write("hello");
      await waitFor(
        () => stripAnsi(session.output()).includes("hello"),
        5_000,
        "input echoed by editor",
      );
      session.term.write("\r");

      await waitFor(
        () => stripAnsi(session.output()).includes("TinyCode mock model"),
        30_000,
        "mock model response",
      );

      // Escape closes the slash-command autocomplete menu that would
      // otherwise swallow the Enter keystroke.
      session.term.write("/exit");
      await waitFor(() => stripAnsi(session.output()).includes("/exit"), 5_000, "/exit echoed");
      session.term.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 150));
      session.term.write("\r");

      const result = await Promise.race([
        session.exited,
        (() => {
          const { promise, reject } = Promise.withResolvers<never>();
          setTimeout(
            () => reject(new Error("TUI did not exit after /exit (lifecycle hang?)")),
            15_000,
          ).unref();
          return promise;
        })(),
      ]);
      expect(result.code).toBe(0);

      // The exchange landed in a persisted session file.
      const sessionsDir = path.join(home, "sessions");
      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThanOrEqual(1);
      const raw = fs.readFileSync(path.join(sessionsDir, files[0]!), "utf8");
      expect(raw).toContain("hello");
      expect(raw).toContain("mock model");
    } finally {
      session.term.kill();
    }
  }, 90_000);

  it("launches without any API key: onboarding panel + mock mode still work", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-pty-ob-home-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-pty-ob-proj-"));

    const session = await spawnTui(makeEnv(home, true), workdir);
    try {
      await waitFor(() => stripAnsi(session.output()).includes("TinyCode v1.0"), 20_000, "startup banner");
      await waitFor(
        () => stripAnsi(session.output()).includes("Setup required"),
        10_000,
        "onboarding setup panel",
      );
      await waitFor(
        () => stripAnsi(session.output()).includes("mock/tinycode-mock"),
        5_000,
        "status bar shows mock model",
      );

      // The mock model still answers while unconfigured.
      session.term.write("hi");
      await waitFor(() => stripAnsi(session.output()).includes("hi"), 5_000, "input echoed");
      session.term.write("\r");
      await waitFor(
        () => stripAnsi(session.output()).includes("TinyCode mock model"),
        30_000,
        "mock reply",
      );

      // Ctrl+D quits cleanly.
      session.term.write("\x04");
      const result = await Promise.race([
        session.exited,
        (() => {
          const { promise, reject } = Promise.withResolvers<never>();
          setTimeout(() => reject(new Error("hang after Ctrl+D")), 10_000).unref();
          return promise;
        })(),
      ]);
      expect(result.code).toBe(0);
    } finally {
      session.term.kill();
    }
  }, 90_000);

  it("double Ctrl+C exits cleanly when idle", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-pty-home2-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-pty-proj2-"));

    const session = await spawnTui(makeEnv(home), workdir);
    try {
      await waitFor(() => stripAnsi(session.output()).includes("TinyCode v1.0"), 20_000, "startup banner");

      // ISIG terminals deliver Ctrl+C as SIGINT; exercise that exact path.
      session.term.kill("SIGINT");
      await waitFor(
        () => stripAnsi(session.output()).toLowerCase().includes("press ctrl+c again"),
        5_000,
        "first Ctrl+C hint",
      );
      session.term.kill("SIGINT");

      const result = await Promise.race([
        session.exited,
        (() => {
          const { promise, reject } = Promise.withResolvers<never>();
          setTimeout(() => reject(new Error("TUI did not exit after double Ctrl+C")), 10_000).unref();
          return promise;
        })(),
      ]);
      expect(result.code).toBe(0);
    } finally {
      session.term.kill();
    }
  }, 60_000);
});
