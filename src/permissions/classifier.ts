/**
 * Tiny, readable shell-command risk classifier.
 *
 * Splits a command line into segments (`&&`, `||`, `;`, `|`) and classifies
 * each segment by its head verb plus a few structural signals (redirection).
 * The segment with the highest risk wins.
 *
 * This is deliberately heuristic: its job is to route decisions between
 * ALLOW / ASK, not to be a security sandbox. The permission layer treats
 * unknown commands conservatively.
 */

export type CommandRisk = "safe" | "write" | "destructive";

export interface CommandClassification {
  risk: CommandRisk;
  /** Human-readable justifications, one per matched rule. */
  reasons: string[];
}

/** Highest risk wins; order matters. */
const RISK_ORDER: Record<CommandRisk, number> = { safe: 0, write: 1, destructive: 2 };

interface VerbRule {
  risk: CommandRisk;
  label: string;
  test: RegExp;
}

const VERB_RULES: VerbRule[] = [
  // Destructive operations — always require approval.
  { risk: "destructive", label: "recursive delete (rm -r)", test: /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*r/i },
  { risk: "destructive", label: "forced delete (rm -f)", test: /\brm\s+(?:-{1,2}[\w-]+\s+)*-\w*f/i },
  { risk: "destructive", label: "git reset --hard", test: /^git\s+reset\s+--hard\b/ },
  { risk: "destructive", label: "git clean", test: /^git\s+clean\b/ },
  { risk: "destructive", label: "force push", test: /^git\s+push\b.*(--force|-f)\b/ },
  { risk: "destructive", label: "sudo", test: /^sudo\b/ },
  { risk: "destructive", label: "disk-level write (dd/mkfs)", test: /^(dd|mkfs(\.\w+)?)\b/ },
  { risk: "destructive", label: "process kill", test: /^(pkill|killall|kill)\b/ },

  // Writes inside the workspace — approval depends on mode.
  { risk: "write", label: "package installation", test: /^(npm|pnpm|yarn|bun)\s+(install|i|add|remove|update|link|publish)\b/ },
  { risk: "write", label: "package execution", test: /^npx\b/ },
  { risk: "write", label: "pip install", test: /^pip3?\s+install\b/ },
  { risk: "write", label: "file mutation", test: /^(mkdir|touch|cp|mv|rsync|ln|tee|truncate|chmod|chown|strip)\b/ },
  { risk: "write", label: "delete", test: /^rmdir\b/ },
  { risk: "write", label: "in-place edit", test: /^sed\b.*-i\b/ },
  { risk: "write", label: "git state change", test: /^git\s+(add|commit|merge|rebase|stash(?!$)|apply|cherry-pick|revert|tag|push|pull|fetch|clone|init|rm|mv)\b/ },
  { risk: "write", label: "build artifacts", test: /^npm\s+run\s+(?!test[\b:])(?!typecheck\b)(?!lint\b)(?!build\b)\S+/ },
];

// Commands considered read-only even though they are not in VERB_RULES.
const SAFE_VERBS =
  /^(ls|cat|head|tail|grep|rg|find|tree|stat|file|wc|diff|cmp|sort|uniq|cut|awk|echo|printf|pwd|which|whoami|hostname|date|env|printenv|true|false|sleep|uname|basename|dirname|realpath|readlink|md5sum|shasum|sha256sum|base64|jq|node|deno|tsx|vitest|tsc|eslint|prettier)\b/;

const SAFE_GIT =
  /^git\s+(status|log|diff|show|branch|remote|rev-parse|describe|blame|shortlog|ls-files|config\s+--get|stash\s+list)\b/;

const SAFE_NPM_SCRIPT = /^(npm(\s+p)?\s+(test|run\s+(test|typecheck|lint|build))[\w:.-]*)$/;

function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function classifySegment(segment: string): CommandClassification {
  const reasons: string[] = [];
  let risk: CommandRisk = "safe";

  const raise = (next: CommandRisk, reason: string) => {
    if (RISK_ORDER[next] > RISK_ORDER[risk]) risk = next;
    reasons.push(reason);
  };

  for (const rule of VERB_RULES) {
    if (rule.test.test(segment)) raise(rule.risk, rule.label);
  }
  // Redirection into a file mutates the filesystem even for safe verbs.
  if (/>>?\s*\S+/.test(segment)) {
    raise("write", "output redirection");
  }

  if (
    risk === "safe" &&
    !SAFE_VERBS.test(segment) &&
    !SAFE_GIT.test(segment) &&
    !SAFE_NPM_SCRIPT.test(segment)
  ) {
    raise("write", "unknown command");
  }
  return { risk, reasons };
}

export function classifyCommand(command: string): CommandClassification {
  const reasons: string[] = [];
  let risk: CommandRisk = "safe";

  // Piping any content into a shell executes arbitrary code; detect it on the
  // whole line because splitSegments removes the pipe characters themselves.
  if (/\|\s*(ba|z|da)?sh\b/.test(command)) {
    reasons.push("pipe into a shell (curl … | sh)");
    risk = "destructive";
  }

  for (const segment of splitSegments(command)) {
    const part = classifySegment(segment);
    reasons.push(...part.reasons.map((r) => `${r} (in "${segment}")`));
    if (RISK_ORDER[part.risk] > RISK_ORDER[risk]) risk = part.risk;
  }
  return { risk, reasons };
}
