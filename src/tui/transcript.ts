import { Container } from "@earendil-works/pi-tui";
import { Markdown, Text } from "@earendil-works/pi-tui";
import type { AgentToolCall } from "@earendil-works/pi-agent-core";
import { fg, bold, dim, markdownTheme } from "./theme.js";
import { formatToolResultLines, formatToolStart } from "./tool-view.js";

/**
 * TranscriptView renders the conversation: user messages, streaming assistant
 * output, tool call/result pairs, errors and system info lines.
 *
 * Streaming strategy: while a message is in progress it is a plain Text
 * component (cheap per-update); on completion it is replaced by a Markdown
 * render.
 */
export class TranscriptView {
  readonly container = new Container();

  addUser(text: string): void {
    const header = new Text(`${bold(fg.brightBlue("❯"))} ${fg.brightBlue("you")}`);
    this.container.addChild(header);
    for (const line of text.split("\n")) {
      this.container.addChild(new Text(`  ${line}`));
    }
    this.container.addChild(new Text(""));
  }

  startAssistant(): AssistantStreamHandle {
    const body = new Text("");
    this.container.addChild(body);
    return {
      update: (text: string) => body.setText(indent(text)),
      finalize: (text: string) => {
        const index = this.container.children.indexOf(body);
        if (index === -1) return;
        this.container.removeChild(body);
        const rendered = new Markdown(text, 2, 0, markdownTheme);
        if (index >= this.container.children.length) {
          this.container.addChild(rendered);
        } else {
          this.container.children.splice(index, 0, rendered);
        }
        this.container.invalidate();
        this.container.addChild(new Text(""));
      },
      fail: (message: string) => {
        body.setText(`${fg.brightRed(message)}`);
        this.container.addChild(new Text(""));
      },
    };
  }

  addToolEntry(toolName: string, args?: Record<string, unknown>): ToolEntryHandle {
    this.container.addChild(new Text(formatToolStart(toolName, args)));
    const resultText = new Text("");
    let hasResult = false;
    return {
      complete: (details, isError, resultPreview) => {
        if (hasResult) return;
        hasResult = true;
        const lines = formatToolResultLines(toolName, details, isError);
        if (!isError && resultPreview && lines.length === 1) {
          lines.push(...resultPreview.slice(0, 3).map((line) => `  ${dim(line)}`));
        }
        if (!isError && details == null && resultPreview == null) lines[0] = `${lines[0]} `;
        resultText.setText(lines.map((line) => `  ${line}`).join("\n"));
        this.container.addChild(resultText);
        this.container.invalidate();
      },
    };
  }

  addError(message: string): void {
    this.container.addChild(new Text(`${fg.brightRed(bold("error"))} ${fg.brightRed(message)}`));
    this.container.addChild(new Text(""));
  }

  addInfo(message: string): void {
    this.container.addChild(new Text(dim(message)));
    this.container.addChild(new Text(""));
  }
}

export interface AssistantStreamHandle {
  update(text: string): void;
  finalize(text: string): void;
  fail(message: string): void;
}

export interface ToolEntryHandle {
  complete(details: unknown, isError: boolean, resultPreview?: string[]): void;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Extract the text of tool call blocks from an assistant message. */
export function toolCallsOf(message: unknown): AgentToolCall[] {
  if (typeof message !== "object" || message === null || !("content" in message)) return [];
  const content = (message as { content: unknown }).content;
  return Array.isArray(content)
    ? content.filter((part): part is AgentToolCall => typeof part === "object" && part !== null && "type" in part && part.type === "toolCall")
    : [];
}

export function textOfMessage(message: unknown): string {
  if (typeof message !== "object" || message === null || !("content" in message)) return "";
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text"
        ? (part as { text: string }).text
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}
