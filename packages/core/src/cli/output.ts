/**
 * Formatting helpers for the `npx @convex-dev/auth` output.
 *
 * They give each message the same shape: a bold section title, then indented
 * lines that start with a status symbol. The libraries are the ones the other
 * Convex command-line tools use: `chalk` for color and `@babel/code-frame` to
 * print TypeScript with line numbers and syntax colors.
 */

import { codeFrameColumns, highlight } from "@babel/code-frame";
import chalk from "chalk";

/**
 * True if the output can show colors. `chalk` decides this from the terminal and
 * from NO_COLOR / FORCE_COLOR. The other libraries follow its decision, which
 * also lets a test turn all color off with `chalk.level = 0`.
 */
function colorEnabled() {
  return chalk.level > 0;
}

/** The dark background of a code block, as an ANSI 256-color index. */
const BACKGROUND = 235;

/** The spaces a code block keeps on each side of the code. */
const HORIZONTAL_PADDING = 2;

/**
 * Status markers, each one character wide so that the columns stay aligned.
 * They are getters because `chalk.level` can change after this module loads.
 */
export const symbols = {
  get done() {
    return chalk.green("✔");
  },
  get skipped() {
    return chalk.yellow("!");
  },
  get failed() {
    return chalk.red("✖");
  },
  get pending() {
    return chalk.dim("•");
  },
};

/** A section title, with an empty line above it. */
export function heading(title: string) {
  return `\n${chalk.bold(title)}`;
}

/** One status line inside a section. */
export function item(symbol: string, text: string) {
  return `  ${symbol} ${text}`;
}

/** A plain indented line, for text that continues an item. */
export function detail(text: string) {
  return `    ${chalk.dim(text)}`;
}

/** Pad a label so that the text after it starts at the same column. */
export function pad(label: string, width: number) {
  return label.padEnd(width);
}

/** A shell command the user must run. */
export function command(text: string) {
  return `    ${chalk.cyan(text)}`;
}

/** A numbered step in the closing instructions. */
export function step(index: number, text: string) {
  return `  ${chalk.dim(`${index}.`)} ${text}`;
}

/** Indent every line of a block by two spaces. */
function indentBlock(text: string) {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
}

/**
 * Print a block of code that the user must copy: syntax-highlighted, on a dark
 * background, and with no line numbers, so that a selection of the block gives
 * back the code and nothing else. `highlight` is the part of
 * `@babel/code-frame` that colors code without the gutter of a frame.
 *
 * The block is as wide as its longest line, plus two spaces on each side and an
 * empty line above and below, so that it reads as one panel.
 *
 * With color off, the code is printed as it is: a background needs padding, and
 * padding is only useful if it can be seen.
 */
export function codeBlock(code: string) {
  const lines = code.replace(/\n+$/, "").split("\n");
  if (!colorEnabled()) return lines.join("\n");

  const width =
    Math.max(...lines.map((line) => line.length)) + 2 * HORIZONTAL_PADDING;
  const colored = highlight(lines.join("\n")).split("\n");
  const row = (text: string, printedLength: number) =>
    chalk.bgAnsi256(BACKGROUND)(
      " ".repeat(HORIZONTAL_PADDING) +
        text +
        " ".repeat(width - HORIZONTAL_PADDING - printedLength),
    );

  return [
    row("", 0),
    ...lines.map((line, index) => row(colored[index], line.length)),
    row("", 0),
  ].join("\n");
}

/**
 * Print the lines around `offset` in `source`, and mark that position with
 * `message`. It points at the syntax error in a file we could not parse.
 */
export function errorFrame(source: string, offset: number, message: string) {
  const linesBefore = source.slice(0, offset).split("\n");
  return indentBlock(
    codeFrameColumns(
      source,
      {
        start: {
          line: linesBefore.length,
          column: (linesBefore.at(-1) ?? "").length + 1,
        },
      },
      { highlightCode: colorEnabled(), message },
    ),
  );
}
