import type { CliArgs } from "./args.js";
import { SessionManager } from "../session/manager.js";
import type { SessionSummary } from "../session/types.js";
import { sessionsDir } from "../config/loader.js";

/**
 * Session option resolution for CLI entry points.
 *
 * Lifecycle:
 *   tinycode                → new session (always)
 *   tinycode --continue     → newest session whose stored cwd matches
 *   tinycode --session <id> → that exact session
 *
 * `--continue` never resumes another project's session; when nothing matches
 * it falls back to a fresh one with a note instead of failing the launch.
 */
export type SessionOption = { mode: "new" } | { mode: "attach"; id: string };

export function pickLatestSessionForCwd(
  manager: SessionManager,
  cwd: string,
): SessionSummary | undefined {
  return manager.list().find((session) => session.cwd === cwd);
}

export function resolveInteractiveSession(
  args: Pick<CliArgs, "continueLast" | "sessionId">,
  cwd: string,
  stderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): SessionOption {
  if (args.continueLast) {
    const latest = pickLatestSessionForCwd(new SessionManager(sessionsDir()), cwd);
    if (!latest) {
      stderr("tinycode: no previous session to continue — starting a fresh one.");
      return { mode: "new" };
    }
    return { mode: "attach", id: latest.id };
  }
  if (args.sessionId) {
    return { mode: "attach", id: args.sessionId };
  }
  // Plain interactive launch owns a live session from the first message.
  return { mode: "new" };
}
