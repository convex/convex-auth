// Fills a fenced code block with the contents of a file of the repository, and
// highlights lines by their *content* rather than by (brittle) line numbers,
// so highlights survive edits to the included source files.
//
// Usage, as an empty code block whose meta names the file (relative to
// `rootDir`):
//
//   ```ts file="examples/react-minimal/convex/auth.ts" title="convex/auth.ts" highlight="import { setupAnonymous }"
//   ```
//
//   highlight="single line anchor"          → highlights the line containing it
//   highlight="start anchor...end anchor"   → highlights the block from the
//                                             line containing `start` down to
//                                             the line after it whose trimmed
//                                             text equals `end`
//
// Each anchor must match exactly one line (the end anchor, one line from the
// start line on). The first `...` separates the anchors, so a single-line
// anchor cannot contain `...` (such as a spread).
//
// The attribute may be repeated to highlight several ranges. Each block turns
// into a plain one whose code marks the highlighted lines with the magic
// comments of Docusaurus (`// highlight-next-line`, `// highlight-start` and
// `// highlight-end`). Docusaurus can also highlight lines with a `{1,4-6}`
// range after the language, but docs.convex.dev wraps its CodeBlock component
// in a way that discards that range. Comments in the code work on both sites.
//
// `resolveCodeIncludes` works on the MDX text and changes nothing else in it.
// This site runs it as the Markdown preprocessor, and a script that copies the
// docs to another site can run it to inline the code, so the copy needs
// neither this module nor the files of the repository.
import { readFileSync } from "node:fs";
import path from "node:path";

/** The `key="value"` attributes of a code block meta string, in order. */
function parseMeta(meta) {
  return [...meta.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => ({
    key,
    value,
  }));
}

/**
 * The comment syntax of the magic comments, by language. Docusaurus reads `//`
 * comments in the JavaScript family and `#` comments in shell-like languages.
 */
const commentPrefixes = {
  js: "//",
  jsx: "//",
  javascript: "//",
  ts: "//",
  tsx: "//",
  typescript: "//",
  bash: "#",
  sh: "#",
  shell: "#",
  python: "#",
  py: "#",
  yaml: "#",
  yml: "#",
};

/** The 0-based line ranges to highlight, in the order of the lines. */
function highlightRanges(lines, patterns, fail) {
  const ranges = [];
  for (const pattern of patterns) {
    // Only the first `...` separates the anchors: any other one is part of the
    // end anchor, which then fails to match rather than being dropped.
    const separator = pattern.indexOf("...");
    const [start, end] = (
      separator === -1
        ? [pattern]
        : [pattern.slice(0, separator), pattern.slice(separator + 3)]
    ).map((part) => part.trim());
    // The start anchor must identify exactly one line, so a highlight can
    // never silently match nothing (a typo) or the wrong line (ambiguous).
    const startMatches = lines.flatMap((line, i) =>
      line.includes(start) ? [i] : [],
    );
    if (startMatches.length === 0) fail(`pattern "${start}" was not found`);
    if (startMatches.length > 1)
      fail(
        `pattern "${start}" matched ${startMatches.length} lines, expected exactly one`,
      );
    const startIdx = startMatches[0];

    let endIdx = startIdx;
    if (end) {
      const endMatches = lines.flatMap((line, i) =>
        i >= startIdx && line.trim() === end ? [i] : [],
      );
      if (endMatches.length === 0)
        fail(`end pattern "${end}" was not found after "${start}"`);
      if (endMatches.length > 1)
        fail(
          `end pattern "${end}" matched ${endMatches.length} lines after "${start}", expected exactly one`,
        );
      endIdx = endMatches[0];
    }
    ranges.push({ start: startIdx, end: endIdx });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].start <= ranges[i - 1].end)
      fail(`highlights overlap at line ${ranges[i].start + 1}`);
  return ranges;
}

/** `lines` with magic comments around the highlighted ranges. */
function withMagicComments(lines, ranges, lang, fail) {
  if (ranges.length === 0) return lines;
  const prefix = commentPrefixes[lang];
  if (!prefix) fail(`cannot highlight lines of language "${lang}"`);
  const out = [];
  let next = 0;
  for (const { start, end } of ranges) {
    out.push(...lines.slice(next, start));
    // Indent the comment like the line, which reads better in the source.
    const indent = /^\s*/.exec(lines[start])[0];
    if (start === end) {
      out.push(`${indent}${prefix} highlight-next-line`, lines[start]);
    } else {
      out.push(
        `${indent}${prefix} highlight-start`,
        ...lines.slice(start, end + 1),
        `${indent}${prefix} highlight-end`,
      );
    }
    next = end + 1;
  }
  out.push(...lines.slice(next));
  return out;
}

/**
 * The lines of the code block that replaces one with a `file` attribute,
 * indented like the original block.
 */
function includedBlock({ indent, lang, attrs, rootDir, fail }) {
  const source = attrs.find((a) => a.key === "file").value;
  let code;
  try {
    code = readFileSync(path.resolve(rootDir, source), "utf8");
  } catch (error) {
    fail(`cannot read the file: ${error.message}`);
  }
  // A trailing newline would render as an empty final line.
  const sourceLines = code.replace(/\n$/, "").split("\n");

  const ranges = highlightRanges(
    sourceLines,
    attrs.filter((a) => a.key === "highlight").map((a) => a.value),
    fail,
  );
  const lines = withMagicComments(sourceLines, ranges, lang, fail);
  const meta = [
    lang,
    ...attrs
      .filter((a) => a.key !== "file" && a.key !== "highlight")
      .map((a) => `${a.key}="${a.value}"`),
  ].filter(Boolean);

  // The fence must be longer than any run of backticks in the code.
  const longestRun = Math.max(
    0,
    ...(code.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [
    `${indent}${fence}${meta.join(" ")}`,
    ...lines.map((line) => (line === "" ? "" : indent + line)),
    `${indent}${fence}`,
  ];
}

/**
 * Inline every code block of `source` (MDX text) that has a `file` attribute.
 *
 * @param {string} source
 * @param {{ rootDir: string, filePath?: string }} options `rootDir` is the
 *   directory the `file` attributes are relative to. `filePath` names the
 *   document in error messages.
 * @returns {string}
 */
export function resolveCodeIncludes(source, { rootDir, filePath = "<mdx>" }) {
  const lines = source.split("\n");
  const out = [];
  // The fence of the code block that `lines[i]` is inside of, if any. A code
  // block inside another one (for example, docs about this syntax) is text.
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === open[0] && close[1].length >= open.length)
        open = null;
      out.push(line);
      continue;
    }

    const opening = /^(\s*)(`{3,}|~{3,})(\S*)(.*)$/.exec(line);
    if (!opening) {
      out.push(line);
      continue;
    }
    const [, indent, fence, lang, rest] = opening;
    const attrs = parseMeta(rest);
    if (!attrs.some((a) => a.key === "file")) {
      open = fence;
      out.push(line);
      continue;
    }

    const where = `${filePath}:${i + 1}`;
    const fail = (message) => {
      throw new Error(`[code-include] ${message} (${where})`);
    };
    // The block may hold blank lines: Prettier writes an empty block as one.
    let end = i + 1;
    while (end < lines.length && lines[end].trim() === "") end++;
    const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[end] ?? "");
    if (
      !closing ||
      closing[1][0] !== fence[0] ||
      closing[1].length < fence.length
    )
      fail("a code block with a `file` attribute must be empty");
    out.push(...includedBlock({ indent, lang, attrs, rootDir, fail }));
    i = end;
  }
  return out.join("\n");
}
