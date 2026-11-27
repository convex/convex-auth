/**
 * Checks that the browser a recording will run is installed, by launching it
 * the way the recorder does and closing it at once. Playwright decides which
 * executable that is (Google Chrome for the `chrome` channel, its headless
 * shell for a headless Chromium, its full Chromium for a window), so the
 * check cannot disagree with the run. Nothing is downloaded.
 *
 * Node-only.
 *
 * @module
 */
import { chromium } from "playwright-core";

export type BrowserChoice = {
  headed: boolean;
  executablePath?: string;
  channel?: string;
};

/** The command that installs Playwright's browsers in this workspace. */
const INSTALL =
  "pnpm --filter @convex-dev/explorer exec playwright-core install";

/** Whether a launch error says the browser is not installed. */
export function isMissingBrowser(message: string): boolean {
  return /Executable doesn't exist|is not found at|distribution '[^']*' is not found|Failed to launch: Error: spawn .* ENOENT/i.test(
    message,
  );
}

/** One plain message for a browser that is not installed. */
export function missingBrowserMessage(choice: BrowserChoice): string {
  if (choice.executablePath !== undefined) {
    return `No browser at ${choice.executablePath}. Give the path of a Chromium-based browser.`;
  }
  if (choice.channel !== undefined) {
    return choice.channel === "chrome"
      ? `Google Chrome is not installed. Install it, or use Playwright's Chromium instead (--browser chromium) after installing it with: ${INSTALL} ${choice.headed ? "chromium" : "chromium-headless-shell"}`
      : `The browser of the channel "${choice.channel}" is not installed.`;
  }
  return choice.headed
    ? `Playwright's Chromium is not installed. Install it with: ${INSTALL} chromium`
    : `Playwright's headless Chromium is not installed. Install it with: ${INSTALL} chromium-headless-shell`;
}

/** Resolves to null when the browser starts, or to why it does not. */
export async function checkBrowser(
  choice: BrowserChoice,
): Promise<string | null> {
  try {
    const browser = await chromium.launch({
      headless: !choice.headed,
      executablePath: choice.executablePath,
      channel: choice.executablePath === undefined ? choice.channel : undefined,
      timeout: 60_000,
    });
    await browser.close();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingBrowser(message)) return missingBrowserMessage(choice);
    // Another failure: its first line, without Playwright's box.
    return `The browser did not start: ${message.split("\n")[0]}`;
  }
}
