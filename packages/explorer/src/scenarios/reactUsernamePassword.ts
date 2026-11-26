/**
 * The scenario of `examples/react-username-password`: sign up, reload (the
 * session comes back from storage), wait for the refresh that the page
 * schedules before its access token expires, sign out, sign in with a wrong
 * password, sign in.
 *
 * Takes about a minute: the access token lives 60 s by default
 * (`packages/core/src/lib/ttl.ts`), and the page refreshes it shortly before
 * it expires.
 *
 * @module
 */
import type { Request } from "playwright-core";
import type { Scenario } from "../scenario.ts";

const signedIn = "button:has-text('Sign out')";

/** Whether a request calls the `refreshSession` mutation over HTTP. */
function isRefresh(request: Request): boolean {
  return (
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/api/mutation" &&
    (request.postData() ?? "").includes('"auth:refreshSession"')
  );
}

const scenario: Scenario = {
  name: "react-username-password",
  description:
    "examples/react-username-password: sign up, reload, scheduled refresh, sign out, wrong password, sign in",
  async run({ page, baseUrl, step, newSecret, unique }) {
    const username = `explorer-${unique}`;
    const password = newSecret("pw");
    const wrongPassword = newSecret("wrong");
    const url = (path: string) => new URL(path, baseUrl).toString();

    await step("open the sign-up page", async () => {
      await page.goto(url("/signup"));
      await page.locator("#username").waitFor();
    });
    await step("sign up", async () => {
      await page
        .locator("#username")
        .pressSequentially(username, { delay: 20 });
      await page
        .locator("#password")
        .pressSequentially(password, { delay: 10 });
      await page.locator("button[type=submit]").click();
      await page.locator(signedIn).waitFor();
      await page.getByText(username).waitFor();
    });
    await step("reload: the session comes back from storage", async () => {
      await page.reload();
      await page.locator(signedIn).waitFor();
      await page.getByText(username).waitFor();
    });
    await step(
      "wait for the scheduled refresh of the access token",
      async () => {
        // The page refreshes once right after it authenticates; wait that out,
        // then for the refresh it schedules before the token expires.
        await page.waitForTimeout(5000);
        const response = await page.waitForResponse(
          (candidate) => isRefresh(candidate.request()),
          { timeout: 120_000 },
        );
        await response.finished();
        // Let the page present the new token on its socket.
        await page.waitForTimeout(1000);
      },
    );
    await step("sign out", async () => {
      await page.locator(signedIn).click();
      await page.waitForURL(url("/login"));
    });
    await step("sign in with a wrong password", async () => {
      await page
        .locator("#username")
        .pressSequentially(username, { delay: 20 });
      await page
        .locator("#password")
        .pressSequentially(wrongPassword, { delay: 10 });
      await page.locator("button[type=submit]").click();
      await page.getByText("Incorrect username or password.").waitFor();
    });
    await step("sign in", async () => {
      await page.locator("#password").fill("");
      await page
        .locator("#password")
        .pressSequentially(password, { delay: 10 });
      await page.locator("button[type=submit]").click();
      await page.locator(signedIn).waitFor();
      await page.getByText(username).waitFor();
    });
  },
};

export default scenario;
