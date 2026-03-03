export interface SkillSummaryView {
  name: string;
  description: string;
}

/**
 * System prompt builder.
 *
 * Kept deliberately short: deterministic rules (permissions, boundaries,
 * truncation) live in the harness, not in the prompt. Project memory and the
 * skill index are appended as context sections.
 */
export function buildSystemPrompt(input: {
  projectRoot: string;
  platform: string;
  memory?: string;
  skills?: SkillSummaryView[];
}): string {
  const sections: string[] = [];

  sections.push(
    `You are TinyCode, a coding agent working inside the project at ${input.projectRoot}.`,
    "",
    "## Working principles",
    "- Understand before you change: read the relevant files and search the code first.",
    "- Make the smallest change that solves the problem; do not refactor unrelated code.",
    "- Never guess file contents or APIs — verify with tools.",
    "- After modifying code, run the project's tests or build to verify.",
    "- If a test fails after your change, fix it and test again.",
    "- Check `git diff` before claiming work is complete.",
    "- Report only what you verified. State failures honestly.",
    "",
    "## Environment",
    `- Project root: ${input.projectRoot}`,
    `- Platform: ${input.platform}`,
    "- All tool paths are relative to the project root; access outside it requires approval.",
    "",
    "## Tools",
    "- read/write/edit/bash/grep/find/ls cover file inspection, modification and commands.",
    "- edit requires exact oldText copied from a previous read; prefer small targeted edits.",
    "- bash runs with a timeout; long outputs are truncated — rerun narrowly if needed.",
  );

  if (input.memory && input.memory.trim().length > 0) {
    sections.push(
      "",
      "## Project memory (TINY.md)",
      "The following instructions come from the project maintainers:",
      "",
      input.memory.trim(),
    );
  }

  if (input.skills && input.skills.length > 0) {
    const list = input.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
    sections.push(
      "",
      "## Skills",
      "Detailed instruction packages available via the load_skill tool:",
      list,
    );
  }

  return sections.join("\n");
}
