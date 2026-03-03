import { Text } from "@earendil-works/pi-tui";
import { fg, dim, bold } from "./theme.js";

export interface StatusBarData {
  model: string;
  tokens: number;
  contextLimit?: number;
  agentsRunning: number;
  agentsMax: number;
  sessionId?: string;
  busy: boolean;
  cwd: string;
}

/**
 * Bottom bar: ● state  model  cwd · ctx tokens · SUB-AGENTS n/m RUNNING · session id
 * Rendered as one composed line so long model ids never wrap mid-token.
 */
export class StatusBar {
  readonly component = new Text("");

  update(data: StatusBarData): void {
    const segments: string[] = [];
    const state = data.busy ? fg.brightYellow("● working") : fg.brightGreen("● ready");
    segments.push(state);
    segments.push(`${bold(data.model)} ${dim(shortCwd(data.cwd))}`);

    const limit = data.contextLimit ? ` / ~${formatK(data.contextLimit)}` : "";
    segments.push(fg.gray(`ctx ~${formatK(data.tokens)}${limit}`));

    if (data.agentsRunning > 0) {
      segments.push(fg.brightMagenta(`SUB-AGENTS ${data.agentsRunning}/${data.agentsMax} RUNNING`));
    }
    if (data.sessionId) {
      segments.push(fg.gray(`session ${data.sessionId.slice(0, 8)}`));
    }

    this.component.setText(segments.join(` ${fg.gray("·")} `));
  }

  /** Convenience for tests and headless rendering. */
  render(width: number): string[] {
    return this.component.render(width);
  }
}

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : "/";
}

function formatK(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
