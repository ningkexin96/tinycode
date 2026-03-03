/**
 * ANSI styling helpers — deliberately dependency-free so the whole visual
 * layer stays readable. Every color helper returns identity when the output
 * is not a terminal (NO_COLOR or piped).
 */

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function style(code: string): (text: string) => string {
  return (text: string) => (enabled && text.length > 0 ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export const fg = {
  gray: style("90"),
  brightBlue: style("94"),
  brightCyan: style("96"),
  brightGreen: style("92"),
  brightYellow: style("93"),
  brightRed: style("91"),
  brightMagenta: style("95"),
};

export const bold = style("1");
export const dim = style("2");
export const italic = style("3");

import type { MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: fg.brightBlue,
  linkUrl: dim,
  code: fg.brightCyan,
  codeBlock: (text) => text,
  codeBlockBorder: fg.gray,
  quote: italic,
  quoteBorder: fg.gray,
  hr: fg.gray,
  listBullet: fg.brightMagenta,
  bold,
  italic,
  strikethrough: dim,
  underline: style("4"),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => text,
  selectedText: fg.brightGreen,
  description: fg.gray,
  scrollInfo: fg.gray,
  noMatch: fg.gray,
};
