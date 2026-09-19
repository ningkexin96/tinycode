import { describe, expect, it } from "vitest";
import { SelectList } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { TranscriptView } from "../src/tui/transcript.js";
import { StatusBar } from "../src/tui/status-bar.js";
import { formatToolStart, formatToolResultLines } from "../src/tui/tool-view.js";
import { SLASH_COMMAND_COMPLETIONS, SLASH_COMMAND_NAMES } from "../src/tui/slash.js";

function plain(lines: string[]): string {
  return lines.map((line) => stripTerminalSequences(line)).join("\n");
}

describe("TranscriptView", () => {
  it("renders user messages", () => {
    const view = new TranscriptView();
    view.addUser("fix the login bug");
    const rendered = plain(view.container.render(80));
    expect(rendered).toContain("you");
    expect(rendered).toContain("fix the login bug");
  });

  it("streams assistant output into an updatable entry and finalizes", () => {
    const view = new TranscriptView();
    const handle = view.startAssistant();
    handle.update("partial ans");
    let rendered = plain(view.container.render(80));
    expect(rendered).toContain("partial ans");

    handle.update("partial answer with more text");
    rendered = plain(view.container.render(80));
    expect(rendered).toContain("more text");

    handle.finalize("**Done** with `code`");
    rendered = plain(view.container.render(80));
    expect(rendered).toContain("Done");
  });

  it("renders tool entries with result summaries", () => {
    const view = new TranscriptView();
    view.addToolEntry("list_tickets", { status: "open" });
    let rendered = plain(view.container.render(80));
    expect(rendered).toContain("● list_tickets open");

    const entry = view.addToolEntry("get_ticket", { ticket_id: "T-1001" });
    rendered = plain(view.container.render(80));
    expect(rendered).toContain("● get_ticket T-1001");
    entry.complete({ ticket: { id: "T-1001", status: "open" } }, false);
    rendered = plain(view.container.render(80));
    expect(rendered).toContain("✓ T-1001");
  });

  it("renders failed tool results distinctly", () => {
    const lines = plain(formatToolResultLines("route_ticket", { queue: "售后组", status: "routed" }, true));
    expect(lines).toContain("✗ → 售后组 · routed");
  });

  it("shows knowledge-edit diffs with add/remove markers", () => {
    const rendered = plain(
      formatToolResultLines(
        "propose_knowledge_edit",
        {
          article_id: "refund-policy",
          additions: 12,
          deletions: 3,
          diff: "+ new line\n- old line",
          rationale: "policy update",
          applied: true,
        },
        false,
      ),
    );
    expect(rendered).toContain("+12 -3");
    expect(rendered).toContain("+ new line");
    expect(rendered).toContain("- old line");
  });

  it("marks a short-circuited knowledge edit", () => {
    const lines = plain(
      formatToolResultLines(
        "propose_knowledge_edit",
        { article_id: "refund-policy", additions: 0, deletions: 0, diff: "", rationale: "noop", applied: false },
        false,
      ),
    );
    expect(lines).toContain("✓ +0 -0（短路跳过）");
  });

  it("reports errors and info lines", () => {
    const view = new TranscriptView();
    view.addError("model unavailable");
    view.addInfo("hint text");
    const rendered = plain(view.container.render(80));
    expect(rendered).toContain("error model unavailable");
    expect(rendered).toContain("hint text");
  });
});

describe("StatusBar", () => {
  it("renders model, tokens, agents and session segments", () => {
    const bar = new StatusBar();
    bar.update({
      model: "anthropic/claude-sonnet-4",
      tokens: 12300,
      agentsRunning: 2,
      agentsMax: 3,
      sessionId: "abcdef1234567890",
      busy: true,
      cwd: "/work/tinycode",
    });
    const rendered = plain(bar.component.render(240));
    expect(rendered).toContain("anthropic/claude-sonnet-4");
    expect(rendered).toContain("ctx ~12.3k");
    expect(rendered).toContain("SUB-AGENTS 2/3 RUNNING");
    expect(rendered).toContain("session abcdef12");
  });

  it("hides agent segment when none are running", () => {
    const bar = new StatusBar();
    bar.update({ model: "mock/m", tokens: 5, agentsRunning: 0, agentsMax: 3, busy: false, cwd: "/" });
    const rendered = plain(bar.component.render(80));
    expect(rendered).not.toContain("SUB-AGENTS");
  });
});

describe("tool start formatting", () => {
  it("summarizes domain tool arguments compactly", () => {
    expect(plain([formatToolStart("get_ticket", { ticket_id: "T-1001" })])).toBe("● get_ticket T-1001");
    expect(plain([formatToolStart("route_ticket", { ticket_id: "T-1001", queue: "售后组" })])).toBe(
      "● route_ticket T-1001 → 售后组",
    );
    expect(plain([formatToolStart("search_knowledge", { query: "退款 时效" })])).toContain("退款 时效");
  });
});

describe("SelectList (permission dialog mechanics)", () => {
  function makeList(): { list: SelectList; picked: string[] } {
    const picked: string[] = [];
    const list = new SelectList(
      [
        { value: "once", label: "Allow once" },
        { value: "always", label: "Always allow this pattern" },
        { value: "deny", label: "Deny" },
      ],
      5,
      {
        selectedPrefix: (t) => t,
        selectedText: (t) => t,
        description: (t) => t,
        scrollInfo: (t) => t,
        noMatch: (t) => t,
      },
    );
    list.onSelect = (item) => picked.push(item.value);
    return { list, picked };
  }

  it("defaults to the first option and confirms with Enter", () => {
    const { list, picked } = makeList();
    list.handleInput("\r");
    expect(picked).toEqual(["once"]);
  });

  it("moves down with arrow keys before confirming", () => {
    const { list, picked } = makeList();
    list.handleInput("\x1b[B"); // down
    list.handleInput("\r");
    expect(picked).toEqual(["always"]);
  });

  it("supports two downs then enter for deny", () => {
    const { list, picked } = makeList();
    list.handleInput("\x1b[B");
    list.handleInput("\x1b[B");
    list.handleInput("\r");
    expect(picked).toEqual(["deny"]);
  });

  it("renders all three options", () => {
    const { list } = makeList();
    const rendered = plain(list.render(60));
    expect(rendered).toContain("Allow once");
    expect(rendered).toContain("Always allow this pattern");
    expect(rendered).toContain("Deny");
  });
});

describe("slash command autocomplete", () => {
  function makeProvider(): CombinedAutocompleteProvider {
    return new CombinedAutocompleteProvider(
      SLASH_COMMAND_COMPLETIONS.map((name) => ({ name, description: "" })),
      process.cwd(),
      null,
    );
  }

  /** Mimic the editor: Enter with the dropdown open accepts the first suggestion. */
  async function acceptFirstSuggestion(typed: string): Promise<string> {
    const provider = makeProvider();
    const suggestions = await provider.getSuggestions([typed], 0, typed.length, {
      signal: new AbortController().signal,
      force: false,
    });
    if (!suggestions) {
      return typed; // no dropdown: the line is submitted verbatim
    }
    const applied = provider.applyCompletion([typed], 0, typed.length, suggestions.items[0]!, suggestions.prefix);
    return applied.lines[0]!.trim();
  }

  // Regression: pi-tui prepends "/" when applying a completion, so passing the
  // "/exit"-style names produced "//exit" and the user could not quit with /exit.
  it("keeps a single leading slash when a suggestion is accepted", async () => {
    expect(await acceptFirstSuggestion("/exit")).toBe("/exit");
    expect(await acceptFirstSuggestion("/hel")).toBe("/help");
  });

  it("round-trips every slash command through the autocomplete provider", async () => {
    for (const name of SLASH_COMMAND_NAMES) {
      expect(await acceptFirstSuggestion(name), name).toBe(name);
    }
  });

  it("keeps the autocomplete names slash-free (pi-tui adds the slash)", () => {
    for (const name of SLASH_COMMAND_COMPLETIONS) {
      expect(name.startsWith("/"), name).toBe(false);
    }
    expect(SLASH_COMMAND_COMPLETIONS).toHaveLength(SLASH_COMMAND_NAMES.length);
  });
});
