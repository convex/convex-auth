// Exports the docs as a self-contained tree, for a site that publishes them
// (such as docs.convex.dev) without this repository.
//
//   node scripts/export-docs.mjs <out-dir>
//
// Copies `docs/` into `<out-dir>`. Each `.md` and `.mdx` file goes through
// `resolveCodeIncludes`, so the code blocks that name a file of the repository
// hold that code. The other files (images, `_category_.json`) are copied as
// they are. `<out-dir>/manifest.json` records the tag, the commit and the time
// of the export.
//
// Run `pnpm api` first: the API reference in `docs/api` is generated.
//
// HEAD must have exactly one tag, which the manifest records. `<out-dir>` must
// not exist
// or it must be empty, so an export never mixes with the files of an earlier
// one.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveCodeIncludes } from "../src/codeInclude.mjs";

const docsPackageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const docsDir = path.join(docsPackageDir, "docs");
const repoRoot = path.resolve(docsPackageDir, "../..");

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** The tag that points at HEAD. Throws unless there is exactly one. */
function tagOfHead() {
  const tags = git("tag", "--points-at", "HEAD").split("\n").filter(Boolean);
  if (tags.length === 0) {
    throw new Error("HEAD has no tag");
  }
  if (tags.length > 1) {
    throw new Error(`HEAD has several tags: ${tags.join(", ")}`);
  }
  return tags[0];
}

/** Copies `src` (a directory) to `dest`, inlining the code of the docs. */
function exportDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      exportDir(from, to);
    } else if (/\.mdx?$/.test(entry.name)) {
      const content = readFileSync(from, "utf8");
      writeFileSync(
        to,
        resolveCodeIncludes(content, { rootDir: repoRoot, filePath: from }),
      );
    } else if (entry.isFile()) {
      copyFileSync(from, to);
    } else {
      throw new Error(`cannot export ${from}: not a file or a directory`);
    }
  }
}

function main() {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (positionals.length !== 1) {
    throw new Error("usage: node scripts/export-docs.mjs <out-dir>");
  }
  const outDir = path.resolve(positionals[0]);
  const tag = tagOfHead();
  if (!existsSync(path.join(docsDir, "api"))) {
    throw new Error("docs/api does not exist: run `pnpm api` first");
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} is not empty`);
  }
  const relative = path.relative(docsDir, outDir);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error(`${outDir} is inside ${docsDir}`);
  }

  exportDir(docsDir, outDir);
  const manifest = {
    tag,
    commit: git("rev-parse", "HEAD"),
    exportedAt: new Date().toISOString(),
  };
  writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`Exported the docs of ${tag} to ${outDir}`);
}

main();
