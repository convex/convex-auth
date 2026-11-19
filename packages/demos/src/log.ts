import { appendFile } from "node:fs/promises";

/** Logging that GitHub Actions shows as groups and annotations. */

const inGitHubActions = process.env.GITHUB_ACTIONS === "true";

export function startGroup(title: string) {
  console.log(inGitHubActions ? `::group::${title}` : `\n=== ${title}`);
}

export function endGroup() {
  if (inGitHubActions) {
    console.log("::endgroup::");
  }
}

function escape(message: string) {
  return message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

export function warning(title: string, message: string) {
  console.log(
    inGitHubActions
      ? `::warning title=${escape(title)}::${escape(message)}`
      : `⚠️  ${title}: ${message}`,
  );
}

export function error(title: string, message: string) {
  console.log(
    inGitHubActions
      ? `::error title=${escape(title)}::${escape(message)}`
      : `❌ ${title}: ${message}`,
  );
}

/** Adds Markdown to the summary of the workflow run. */
export async function writeSummary(markdown: string) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) {
    await appendFile(path, markdown);
  } else {
    console.log(`\n${markdown}`);
  }
}
