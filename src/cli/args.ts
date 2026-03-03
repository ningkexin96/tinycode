/**
 * Minimal CLI argument parser (no dependency needed for our flag set).
 *
 * Supported:
 *   tinycode [--help] [--version]
 *   tinycode [--continue | --session <id>] [--model provider/model]
 *            [--permission-mode ask|auto] [--mock] [--list-models]
 *   tinycode -p "prompt"        non-interactive print mode
 */
export interface CliArgs {
  help: boolean;
  version: boolean;
  continueLast: boolean;
  sessionId?: string;
  model?: string;
  permissionMode?: "ask" | "auto";
  mock: boolean;
  listModels: boolean;
  prompt?: string;
}

export class CliArgsError extends Error {}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { help: false, version: false, continueLast: false, mock: false, listModels: false };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "--continue":
      case "-c":
        args.continueLast = true;
        break;
      case "--session":
      case "-s": {
        const value = argv[++index];
        if (!value) throw new CliArgsError(`${arg} requires a session id`);
        args.sessionId = value;
        break;
      }
      case "--model":
      case "-m": {
        const value = argv[++index];
        if (!value) throw new CliArgsError(`${arg} requires provider/model`);
        args.model = value;
        break;
      }
      case "--permission-mode":
      case "--perm": {
        const value = argv[++index];
        if (value !== "ask" && value !== "auto") {
          throw new CliArgsError(`${arg} must be "ask" or "auto"`);
        }
        args.permissionMode = value;
        break;
      }
      case "--mock":
        args.mock = true;
        break;
      case "--list-models":
        args.listModels = true;
        break;
      case "-p":
      case "--print": {
        const value = argv[++index];
        if (value === undefined) throw new CliArgsError("-p requires a prompt string");
        // Allow the prompt to be the rest of the arguments when quoted loosely.
        args.prompt = [value, ...argv.slice(index + 1)].join(" ");
        index = argv.length;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new CliArgsError(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (positional.length > 0 && !args.prompt) {
    throw new CliArgsError(
      `Unexpected argument(s): ${positional.join(" ")}. Use -p "<prompt>" for one-shot runs.`,
    );
  }
  return args;
}

/** Split "provider/model" into its parts. */
export function parseModelRef(ref: string): ModelRefLike {
  const slash = ref.indexOf("/");
  if (slash === -1) return { model: ref };
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

export interface ModelRefLike {
  provider?: string;
  model?: string;
}
